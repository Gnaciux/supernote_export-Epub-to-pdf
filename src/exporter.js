/**
 * Export EPUB to PDF — export pipeline.
 *
 * For each page:
 *   1. The SDK renders the document page exactly as the Supernote lays it out
 *      (PluginDocAPI.generateCurrentDocImage), into the plugin's private folder.
 *   2. We read the page's handwriting (PluginFileAPI.getElements) and take each
 *      stroke's real outline (contoursSrc): the same shape the device draws.
 *   3. The native module composites page + ink and appends it to a PDF, which is
 *      copied to EXPORT only when complete.
 *
 * Files touched: the open document is only read. The plugin writes temporary
 * files in its own private folder and one PDF in EXPORT. Nothing else.
 */
import { NativeModules } from 'react-native';
import {
  PluginManager,
  PluginCommAPI,
  PluginDocAPI,
  PluginFileAPI,
  FileUtils,
} from 'sn-plugin-lib';

const Renderer = NativeModules.EpubPdfRenderer;

const PERM_READ = 'plugin.permission.FILE:READ';
const PERM_WRITE = 'plugin.permission.FILE:WRITE';

const TYPE_STROKE = 0;
const TYPE_GEO = 700;
const TYPE_FIVE_STAR = 800;
const PEN_MARKER = 11;

/** Error with a code the UI translates (see i18n.ts, err_*). */
export class ExportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail || '';
  }
}

// ---------------------------------------------------------------- helpers

function ok(resp) {
  return resp && resp.success !== false && resp.result !== undefined;
}

function errText(resp) {
  if (!resp) return 'no response';
  if (resp.error) return `${resp.error.code}: ${resp.error.message}`;
  return JSON.stringify(resp).slice(0, 200);
}

async function safe(promise) {
  try {
    return await promise;
  } catch (e) {
    return { success: false, error: { code: -1, message: String(e && e.message ? e.message : e) } };
  }
}

function baseName(path) {
  const file = String(path || 'document').split('/').pop() || 'document';
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return stem.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}-${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`;
}

/** Ask for a permission if we do not have it yet. Returns true when granted. */
export async function ensurePermission(permission, desc) {
  try {
    const status = await PluginManager.hasPermission(permission);
    if (status === 1) return true;
    const res = await PluginManager.requestPermission(permission, desc);
    return res === 1 || res === 2;
  } catch (e) {
    return false;
  }
}

export async function getLanguage() {
  try {
    return String((await Renderer.getLanguage()) || 'en');
  } catch (e) {
    return 'en';
  }
}

// ---------------------------------------------------------------- document info

/**
 * Reads the open document. `strings.permRead` is shown in the permission prompt.
 * marked === null means the annotation index is not available: the export then
 * looks for ink page by page.
 */
export async function getDocInfo(strings) {
  if (!Renderer) throw new ExportError('err_native');
  const fileResp = await safe(PluginCommAPI.getCurrentFilePath());
  if (!ok(fileResp) || !fileResp.result) throw new ExportError('err_no_doc', errText(fileResp));
  const filePath = String(fileResp.result);

  const totalResp = await safe(PluginDocAPI.getCurrentTotalPages());
  const total = ok(totalResp) ? Number(totalResp.result) : 0;

  const curResp = await safe(PluginCommAPI.getCurrentPageNum());
  const current = ok(curResp) ? Number(curResp.result) : 0;

  // The annotation index is a READ operation: without the permission the host
  // silently returns nothing, so ask first.
  const canRead = await ensurePermission(PERM_READ, strings.permRead);
  let marked = null;
  if (canRead) {
    const markResp = await safe(PluginFileAPI.getMarkPages(filePath));
    if (ok(markResp) && Array.isArray(markResp.result)) {
      const list = markResp.result
        .map(Number)
        .filter((p) => Number.isInteger(p) && p >= 0 && (total <= 0 || p < total));
      if (list.length > 0) marked = Array.from(new Set(list)).sort((a, b) => a - b);
    }
  }

  return { filePath, name: baseName(filePath), total, current, marked, canRead };
}

// ---------------------------------------------------------------- page geometry

async function pageSize(filePath, page) {
  const r = await safe(PluginFileAPI.getPageSize(filePath, page));
  if (ok(r) && r.result && r.result.width > 0 && r.result.height > 0) {
    return { width: Math.round(r.result.width), height: Math.round(r.result.height), exact: true };
  }
  const d = await safe(PluginCommAPI.getPageDisplaySize());
  if (ok(d) && d.result && d.result.width > 0 && d.result.height > 0) {
    return { width: Math.round(d.result.width), height: Math.round(d.result.height), exact: false };
  }
  return { width: 1404, height: 1872, exact: false };
}

// ---------------------------------------------------------------- ink

function isInk(el) {
  return !!el && ((el.type === TYPE_STROKE && el.stroke) || (el.type === TYPE_GEO && el.geometry) || el.type === TYPE_FIVE_STAR);
}

async function loadElements(filePath, page) {
  const res = await safe(PluginFileAPI.getElements(page, filePath));
  return ok(res) && Array.isArray(res.result) ? res.result : [];
}

function releaseElements() {
  try {
    PluginCommAPI.clearElementCache();
  } catch (e) {}
}

async function readContours(el) {
  const acc = el && el.contoursSrc;
  if (!acc || typeof acc.size !== 'function') return [];
  const n = await acc.size();
  if (!n || n <= 0) return [];
  const arrays = await acc.getRange(0, n);
  const polys = [];
  for (const contour of arrays || []) {
    if (!Array.isArray(contour) || contour.length < 2) continue;
    const flat = new Array(contour.length * 2);
    for (let i = 0; i < contour.length; i++) {
      flat[2 * i] = contour[i].x;
      flat[2 * i + 1] = contour[i].y;
    }
    polys.push(flat);
  }
  return polys;
}

/** Turn loaded elements into { markers, pens } for the native renderer. */
async function buildInk(elements) {
  const out = { markers: [], pens: [] };
  const inks = elements.filter(isInk);
  // Fetch every outline at once: the bridge calls overlap instead of queueing.
  const all = await Promise.all(inks.map((el) => readContours(el).catch(() => [])));
  inks.forEach((el, idx) => {
    const polys = all[idx];
    if (!polys || polys.length === 0) return;
    const src = el.type === TYPE_GEO ? el.geometry : el.stroke;
    const grey = src ? Number(src.penColor) || 0 : 0;
    const marker = src ? Number(src.penType) === PEN_MARKER : false;
    (marker ? out.markers : out.pens).push({ grey, polys });
  });
  return out;
}

// ---------------------------------------------------------------- export

/**
 * opts = {
 *   info: result of getDocInfo()
 *   scope: 'marked' | 'current' | 'range' | 'all'
 *   from, to: 1-based page numbers for 'range'
 *   highlights: boolean            // include text-selection highlights
 *   strings: { permRead, permWrite, fileSuffix }
 *   onProgress({ index, total, page, exported, scanning, saving })
 *   isCancelled(): boolean
 * }
 * Returns { path, fileName, pages, kb, seconds }.
 */
export async function runExport(opts) {
  const { info, scope, highlights, strings, onProgress } = opts;
  const cancelled = () => (opts.isCancelled ? opts.isCancelled() : false);
  const t0 = Date.now();

  const canRead = await ensurePermission(PERM_READ, strings.permRead);
  if (!canRead) throw new ExportError('err_perm_read');
  const canWrite = await ensurePermission(PERM_WRITE, strings.permWrite);
  if (!canWrite) throw new ExportError('err_perm_write');

  // Page list. Without an annotation index we walk every page and keep the
  // ones that carry ink (cheap: pages without ink are never rendered).
  let pages = [];
  let scanning = false;
  if (scope === 'all') {
    pages = Array.from({ length: info.total }, (_, i) => i);
  } else if (scope === 'current') {
    pages = [info.current];
  } else if (scope === 'range') {
    const a = Math.max(1, Math.min(opts.from, opts.to));
    const b = Math.min(info.total || a, Math.max(opts.from, opts.to));
    for (let p = a; p <= b; p++) pages.push(p - 1);
  } else if (info.marked && info.marked.length > 0) {
    pages = info.marked.slice();
  } else {
    pages = Array.from({ length: info.total }, (_, i) => i);
    scanning = true;
  }
  if (pages.length === 0) throw new ExportError('err_no_pages');

  // Paths: temp files in the plugin's private folder, result in EXPORT.
  const pluginDir = String((await PluginManager.getPluginDirPath()) || '').replace(/\/+$/, '');
  if (!pluginDir) throw new ExportError('err_internal', 'plugin dir');
  let exportDir = '';
  try {
    exportDir = String((await FileUtils.getExportPath()) || '');
  } catch (e) {}
  if (!exportDir) exportDir = '/storage/emulated/0/EXPORT';
  exportDir = exportDir.replace(/\/+$/, '');

  let fileName = `${info.name}${strings.fileSuffix}.pdf`;
  if (await Renderer.fileExists(`${exportDir}/${fileName}`)) {
    fileName = `${info.name}${strings.fileSuffix} ${stamp()}.pdf`;
  }
  const outPdf = `${exportDir}/${fileName}`;
  const tmpPdf = `${pluginDir}/epx_export.pdf`;
  const basePng = `${pluginDir}/epx_page.png`;

  await Renderer.beginPdf(tmpPdf);
  let exported = 0;
  let pageSizeCache = null;
  try {
    for (let i = 0; i < pages.length; i++) {
      if (cancelled()) throw new ExportError('cancelled');
      const page = pages[i];
      if (onProgress) onProgress({ index: i, total: pages.length, page, exported, scanning, saving: false });

      // Elements first: they tell us whether a scanned page is worth rendering.
      const elements = await loadElements(info.filePath, page);
      if (scanning && !elements.some(isInk)) {
        releaseElements();
        continue;
      }

      // All pages of one EPUB layout share a size; ask once.
      const size = pageSizeCache || (await pageSize(info.filePath, page));
      if (!pageSizeCache && size.exact) pageSizeCache = size;

      // 1) the page exactly as the Supernote renders it
      const img = await safe(PluginDocAPI.generateCurrentDocImage(
        page, basePng, { width: size.width, height: size.height }, highlights ? 1 : 0));
      const baseOk = ok(img) && img.result !== false;

      // 2) the handwriting on top
      const ink = await buildInk(elements);
      releaseElements();

      await Renderer.addPage({
        basePng: baseOk ? basePng : '',
        width: size.width,
        height: size.height,
        scale: 1,
        pointsPerPx: 72 / 226,
        markers: ink.markers,
        pens: ink.pens,
      });
      exported++;
    }

    if (exported === 0) throw new ExportError(scanning ? 'err_no_ink' : 'err_no_pages');
    if (onProgress) onProgress({ index: pages.length, total: pages.length, page: -1, exported, scanning, saving: true });
    const done = await Renderer.finishPdf(outPdf);
    await safe(Renderer.deleteTemp(basePng));
    return {
      path: done.path,
      fileName,
      folder: 'EXPORT',
      exportDir,
      pages: done.pages,
      kb: Math.round(done.bytes / 1024),
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  } catch (e) {
    await safe(Renderer.abortPdf());
    await safe(Renderer.deleteTemp(basePng));
    releaseElements();
    if (e instanceof ExportError) throw e;
    throw new ExportError('err_internal', e && e.message ? e.message : String(e));
  }
}

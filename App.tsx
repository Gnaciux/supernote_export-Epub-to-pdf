/**
 * Export EPUB to PDF — plugin UI.
 *
 * A compact dialog in the style of Supernote's own (Chauvet) dialogs: white card,
 * black outline, centred title with a close button, segmented choices, a switch,
 * and two equal buttons at the bottom. Tapping outside the card closes it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { FileUtils, PluginManager } from 'sn-plugin-lib';
// @ts-ignore plain JS module
import { getDocInfo, getLanguage, runExport } from './src/exporter';
import { stringsFor, Strings } from './src/i18n';

type Scope = 'marked' | 'current' | 'range' | 'all';
type Phase = 'loading' | 'ready' | 'working' | 'done' | 'error';

const BLACK = '#000000';
const WHITE = '#FFFFFF';
const GREY = '#6B6B6B';
const LINE = '#C8C8C8';

// ---------------------------------------------------------------- small components

function Segmented(props: { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <View style={s.segment}>
      {props.options.map((o, i) => {
        const on = o.key === props.value;
        return (
          <Pressable
            key={o.key}
            onPress={() => props.onChange(o.key)}
            style={[s.segItem, i > 0 && s.segDivider, on && s.segItemOn]}>
            <Text style={[s.segText, on && s.segTextOn]} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Switch(props: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <Pressable style={s.switchRow} onPress={() => props.onChange(!props.value)}>
      <View style={s.switchText}>
        <Text style={s.label}>{props.label}</Text>
        {props.hint ? <Text style={s.hint}>{props.hint}</Text> : null}
      </View>
      <View style={[s.track, props.value && s.trackOn]}>
        <View style={[s.knob, props.value ? s.knobOn : s.knobOff]} />
      </View>
    </Pressable>
  );
}

function Button(props: { label: string; primary?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={[s.btn, props.primary ? s.btnPrimary : s.btnSecondary]}>
      <Text style={[s.btnText, props.primary && s.btnTextPrimary]}>{props.label}</Text>
    </Pressable>
  );
}

function ProgressBar(props: { value: number }) {
  const pct = Math.max(0, Math.min(1, props.value));
  return (
    <View style={s.bar}>
      <View style={[s.barFill, { width: `${Math.round(pct * 100)}%` }]} />
    </View>
  );
}

// ---------------------------------------------------------------- app

function App(): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const cardWidth = Math.round(Math.min(Math.max(width * 0.6, 480), 680, width - 48));

  const [t, setT] = useState<Strings>(stringsFor('en'));
  const tRef = useRef(t);
  tRef.current = t;

  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<any>(null);
  const [scope, setScope] = useState<Scope>('marked');
  const [highlights, setHighlights] = useState(true);
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('1');
  const [progress, setProgress] = useState({ value: 0, line1: '', line2: '' });
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const cancelRef = useRef(false);
  const lastShown = useRef({ index: -1, exported: -1 });

  const load = useCallback(async () => {
    if (busy.current) return;
    setPhase('loading');
    setResult(null);
    setError('');
    try {
      const strings = stringsFor(await getLanguage());
      setT(strings);
      const i = await getDocInfo(strings);
      setInfo(i);
      setScope('marked');
      setFrom(String(i.current + 1));
      setTo(String(Math.min(i.total || i.current + 1, i.current + 10)));
      setPhase('ready');
    } catch (e: any) {
      const strings = tRef.current as any;
      setError(strings[e?.code] || strings.err_internal);
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    load();
    // The host re-shows the same component on each button press: refresh then.
    const btn = PluginManager.registerButtonListener({ onButtonPress: () => load() });
    const lang = PluginManager.registerLangListener({ onMsg: (msg: any) => setT(stringsFor(String(msg))) });
    return () => {
      btn.remove();
      lang.remove();
    };
  }, [load]);

  const close = () => {
    if (busy.current) return;
    PluginManager.closePluginView();
  };

  const start = async () => {
    if (!info || busy.current) return;
    busy.current = true;
    cancelRef.current = false;
    setCancelling(false);
    lastShown.current = { index: -1, exported: -1 };
    setPhase('working');
    setProgress({ value: 0, line1: t.exporting, line2: '' });
    try {
      const r = await runExport({
        info,
        scope,
        highlights,
        strings: { permRead: t.permRead, permWrite: t.permWrite, fileSuffix: t.fileSuffix },
        from: parseInt(from, 10) || 1,
        to: parseInt(to, 10) || 1,
        isCancelled: () => cancelRef.current,
        onProgress: (p: any) => {
          if (cancelRef.current) return;
          if (p.saving) {
            setProgress({ value: 1, line1: t.saving, line2: '' });
            return;
          }
          // E-ink: refresh at most every 5 scanned pages, or when a page is added.
          if (p.scanning && p.index - lastShown.current.index < 5 && p.exported === lastShown.current.exported) return;
          lastShown.current = { index: p.index, exported: p.exported };
          setProgress(p.scanning
            ? { value: p.index / p.total, line1: t.scanningPage(p.page + 1, p.total), line2: t.found(p.exported) }
            : { value: p.index / p.total, line1: t.exportingPage(p.index + 1, p.total), line2: '' });
        },
      });
      setResult(r);
      setPhase('done');
    } catch (e: any) {
      if (e?.code === 'cancelled') {
        setPhase('ready');
      } else {
        const strings = t as any;
        setError(strings[e?.code] || strings.err_internal);
        setPhase('error');
      }
    } finally {
      busy.current = false;
    }
  };

  const cancelExport = () => {
    cancelRef.current = true;
    setCancelling(true);
    setProgress((p) => ({ ...p, line1: t.cancelling, line2: '' }));
  };

  const openFolder = async () => {
    try {
      await FileUtils.openFilePath(result?.exportDir || '/storage/emulated/0/EXPORT');
    } catch (e) {}
    PluginManager.closePluginView();
  };

  const summary = useMemo(() => {
    if (!info) return '';
    switch (scope) {
      case 'marked':
        return Array.isArray(info.marked) ? t.summaryMarked(info.marked.length) : t.summaryScan;
      case 'current':
        return t.summaryCurrent(info.current + 1);
      case 'range': {
        const a = parseInt(from, 10) || 1;
        const b = parseInt(to, 10) || a;
        return t.summaryRange(Math.min(a, b), Math.max(a, b));
      }
      default:
        return t.summaryAll(info.total);
    }
  }, [info, scope, from, to, t]);

  // ---------------------------------------------------------------- render

  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;

  if (phase === 'loading') {
    body = <Text style={[s.center, s.msg]}>{t.loading}</Text>;
  } else if (phase === 'error') {
    body = (
      <View>
        <Text style={[s.center, s.msgStrong]}>{t.errorTitle}</Text>
        <Text style={[s.center, s.msg]}>{error}</Text>
      </View>
    );
    footer = (
      <>
        <Button label={t.close} onPress={close} />
        <Button label={t.back} primary onPress={load} />
      </>
    );
  } else if (phase === 'ready' && info) {
    body = (
      <View>
        <Text style={s.docName} numberOfLines={2}>{info.name}</Text>

        <Text style={s.section}>{t.pages}</Text>
        <Segmented
          value={scope}
          onChange={(k) => setScope(k as Scope)}
          options={[
            { key: 'marked', label: t.scopeMarked },
            { key: 'current', label: t.scopeCurrent },
            { key: 'range', label: t.scopeRange },
            { key: 'all', label: t.scopeAll },
          ]}
        />
        {scope === 'range' && (
          <View style={s.rangeRow}>
            <Text style={s.label}>{t.from}</Text>
            <TextInput style={s.input} keyboardType="number-pad" value={from} onChangeText={setFrom} maxLength={5} />
            <Text style={s.label}>{t.to}</Text>
            <TextInput style={s.input} keyboardType="number-pad" value={to} onChangeText={setTo} maxLength={5} />
          </View>
        )}
        <Text style={s.hint}>{summary}</Text>

        <View style={s.separator} />
        <Switch value={highlights} onChange={setHighlights} label={t.highlights} hint={t.highlightsHint} />
      </View>
    );
    footer = (
      <>
        <Button label={t.cancel} onPress={close} />
        <Button label={t.export} primary onPress={start} />
      </>
    );
  } else if (phase === 'working') {
    body = (
      <View>
        <Text style={[s.center, s.msgStrong]}>{progress.line1}</Text>
        <ProgressBar value={progress.value} />
        {progress.line2 ? <Text style={[s.center, s.hint]}>{progress.line2}</Text> : null}
        <Text style={[s.center, s.hint]}>{t.keepOpen}</Text>
      </View>
    );
    footer = <Button label={cancelling ? t.cancelling : t.cancel} onPress={cancelExport} />;
  } else if (phase === 'done' && result) {
    body = (
      <View>
        <View style={s.doneMark}><Text style={s.doneTick}>✓</Text></View>
        <Text style={[s.center, s.msgStrong]}>{t.doneTitle}</Text>
        <Text style={[s.center, s.fileName]} numberOfLines={3}>{result.fileName}</Text>
        <Text style={[s.center, s.hint]}>{t.doneIn}</Text>
        <Text style={[s.center, s.hint]}>{t.doneStats(result.pages, result.kb, result.seconds)}</Text>
      </View>
    );
    footer = (
      <>
        <Button label={t.openFolder} onPress={openFolder} />
        <Button label={t.done} primary onPress={() => PluginManager.closePluginView()} />
      </>
    );
  }

  return (
    <View style={s.root}>
      {/* Tap outside the card to close (ignored while exporting). */}
      <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      <View style={[s.card, { width: cardWidth, maxHeight: height - 48 }]}>
        <View style={s.header}>
          <Text style={s.title}>{t.title}</Text>
          {phase !== 'working' && (
            <Pressable onPress={close} style={s.closeBtn} hitSlop={20}>
              <Text style={s.closeText}>✕</Text>
            </Pressable>
          )}
        </View>
        <View style={s.headerLine} />
        <View style={s.body}>{body}</View>
        {footer ? <View style={s.footer}>{footer}</View> : <View style={s.footerSpacer} />}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- styles

const s = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  card: {
    backgroundColor: WHITE,
    borderColor: BLACK,
    borderWidth: 2,
    borderRadius: 16,
    overflow: 'hidden',
  },
  header: { height: 64, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: BLACK },
  closeBtn: { position: 'absolute', right: 18, top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 6 },
  closeText: { fontSize: 26, color: BLACK },
  headerLine: { height: 1, backgroundColor: LINE },
  body: { paddingHorizontal: 32, paddingTop: 22, paddingBottom: 8 },
  footer: { flexDirection: 'row', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28 },
  footerSpacer: { height: 24 },

  docName: { fontSize: 19, fontWeight: '600', color: BLACK, textAlign: 'center', marginBottom: 6 },
  section: { fontSize: 17, fontWeight: '700', color: BLACK, marginTop: 14, marginBottom: 10 },
  label: { fontSize: 18, color: BLACK },
  hint: { fontSize: 15, color: GREY, marginTop: 8 },
  center: { textAlign: 'center' },
  msg: { fontSize: 18, color: BLACK, marginVertical: 18, lineHeight: 26 },
  msgStrong: { fontSize: 20, fontWeight: '700', color: BLACK, marginTop: 6, marginBottom: 6 },
  fileName: { fontSize: 17, color: BLACK, marginTop: 6 },

  segment: { flexDirection: 'row', borderWidth: 2, borderColor: BLACK, borderRadius: 10, overflow: 'hidden' },
  segItem: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: WHITE },
  segDivider: { borderLeftWidth: 2, borderLeftColor: BLACK },
  segItemOn: { backgroundColor: BLACK },
  segText: { fontSize: 17, color: BLACK, fontWeight: '600' },
  segTextOn: { color: WHITE },

  rangeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  input: {
    width: 96, height: 44, fontSize: 18, color: BLACK, textAlign: 'center',
    borderWidth: 2, borderColor: BLACK, borderRadius: 8, marginHorizontal: 12, paddingVertical: 0,
  },

  separator: { height: 1, backgroundColor: LINE, marginTop: 20, marginBottom: 6 },
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  switchText: { flex: 1, paddingRight: 16 },
  track: {
    width: 56, height: 30, borderRadius: 15, borderWidth: 2, borderColor: BLACK,
    backgroundColor: WHITE, justifyContent: 'center',
  },
  trackOn: { backgroundColor: BLACK },
  knob: { width: 22, height: 22, borderRadius: 11, position: 'absolute' },
  knobOff: { left: 2, backgroundColor: BLACK },
  knobOn: { right: 2, backgroundColor: WHITE },

  btn: { flex: 1, height: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 },
  btnPrimary: { backgroundColor: BLACK },
  btnSecondary: { backgroundColor: WHITE, borderWidth: 2, borderColor: BLACK },
  btnText: { fontSize: 19, fontWeight: '600', color: BLACK },
  btnTextPrimary: { color: WHITE },

  bar: { height: 14, borderWidth: 2, borderColor: BLACK, borderRadius: 7, overflow: 'hidden', marginVertical: 16 },
  barFill: { height: '100%', backgroundColor: BLACK },

  doneMark: {
    alignSelf: 'center', width: 52, height: 52, borderRadius: 26, borderWidth: 2, borderColor: BLACK,
    alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },
  doneTick: { fontSize: 28, color: BLACK, fontWeight: '700' },
});

export default App;

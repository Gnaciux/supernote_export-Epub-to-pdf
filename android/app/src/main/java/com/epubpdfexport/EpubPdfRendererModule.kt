package com.epubpdfexport

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.Locale

/**
 * Native side of "Export EPUB to PDF".
 *
 * JS renders each page with the SDK and reads the stroke outlines of that page.
 * This module composites page + ink into one bitmap and appends it to a PDF.
 *
 * The PDF is written to a temporary file in the plugin's private folder and only
 * copied to its destination (EXPORT) once it is complete, so a cancelled or failed
 * export never leaves a partial file in the user's folders.
 *
 * Usage from JS: beginPdf(tmp) -> addPage(...) x N -> finishPdf(dest) | abortPdf()
 */
class EpubPdfRendererModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var pdf: GrayPdfWriter? = null
    private var tmpPath: String? = null

    override fun getName(): String = "EpubPdfRenderer"

    // ---------- helpers ----------

    /** Supernote pen colour (0x00, 0x9D, 0xC9, 0xFE or a full ARGB int) -> opaque grey. */
    private fun greyOf(penColor: Int): Int {
        val v: Int = if (penColor in 0..0xFF) {
            penColor
        } else {
            val r = (penColor shr 16) and 0xFF
            val g = (penColor shr 8) and 0xFF
            val b = penColor and 0xFF
            ((r * 299 + g * 587 + b * 114) / 1000)
        }
        return Color.rgb(v, v, v)
    }

    /** Build a path from [[x0,y0,x1,y1,...], [...]] polygons, scaled by s. */
    private fun pathOf(polys: ReadableArray?, s: Float): Path {
        val p = Path()
        p.fillType = Path.FillType.WINDING
        if (polys == null) return p
        for (i in 0 until polys.size()) {
            val poly = polys.getArray(i) ?: continue
            val n = poly.size()
            if (n < 4) continue
            p.moveTo(poly.getDouble(0).toFloat() * s, poly.getDouble(1).toFloat() * s)
            var k = 2
            while (k + 1 < n) {
                p.lineTo(poly.getDouble(k).toFloat() * s, poly.getDouble(k + 1).toFloat() * s)
                k += 2
            }
            p.close()
        }
        return p
    }

    private fun decodeScaled(path: String, w: Int, h: Int): Bitmap? {
        val f = File(path)
        if (!f.exists() || f.length() == 0L) return null
        val opts = BitmapFactory.Options()
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888
        opts.inMutable = true
        val src = BitmapFactory.decodeFile(path, opts) ?: return null
        if (src.width == w && src.height == h && src.isMutable && src.config == Bitmap.Config.ARGB_8888) {
            return src
        }
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        c.drawColor(Color.WHITE)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
        c.drawBitmap(src, Rect(0, 0, src.width, src.height), Rect(0, 0, w, h), paint)
        src.recycle()
        return out
    }

    /** Multiply `layer` (opaque, white = no change) onto `base`. */
    private fun multiplyOnto(base: Bitmap, layer: Bitmap) {
        val c = Canvas(base)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.MULTIPLY)
        c.drawBitmap(layer, Rect(0, 0, layer.width, layer.height), Rect(0, 0, base.width, base.height), paint)
    }

    // ---------- API ----------

    /** Two-letter system language, e.g. "en", "es". */
    @ReactMethod
    fun getLanguage(promise: Promise) {
        try {
            val cfg = reactApplicationContext.resources.configuration
            val loc: Locale = if (android.os.Build.VERSION.SDK_INT >= 24) cfg.locales.get(0) else @Suppress("DEPRECATION") cfg.locale
            promise.resolve(loc.language ?: "en")
        } catch (e: Throwable) {
            promise.resolve(Locale.getDefault().language ?: "en")
        }
    }

    @ReactMethod
    fun beginPdf(tmp: String, promise: Promise) {
        try {
            pdf?.abort()
            val f = File(tmp)
            f.parentFile?.mkdirs()
            pdf = GrayPdfWriter(f)
            tmpPath = tmp
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("BEGIN", e.message, e)
        }
    }

    /**
     * spec = {
     *   basePng: string        // page rendered by the SDK ("" -> white page)
     *   width, height: number  // page size in the stroke coordinate space
     *   scale: number          // output pixels per page unit (1 = device resolution)
     *   markers: [ { grey:int, polys:[[x,y,...],...] } ]   // drawn as a transparent wash
     *   pens:    [ { grey:int, polys:[[x,y,...],...] } ]   // drawn opaque on top
     *   pointsPerPx: number    // PDF points per output pixel
     * }
     */
    @ReactMethod
    fun addPage(spec: ReadableMap, promise: Promise) {
        val doc = pdf
        if (doc == null) {
            promise.reject("NO_PDF", "beginPdf was not called")
            return
        }
        var page: Bitmap? = null
        try {
            val scale = if (spec.hasKey("scale")) spec.getDouble("scale").toFloat() else 1f
            val w = Math.max(1, Math.round(spec.getDouble("width").toFloat() * scale))
            val h = Math.max(1, Math.round(spec.getDouble("height").toFloat() * scale))

            val basePath = if (spec.hasKey("basePng")) spec.getString("basePng") ?: "" else ""
            page = if (basePath.isNotEmpty()) decodeScaled(basePath, w, h) else null
            val baseOk = page != null
            if (page == null) {
                page = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                Canvas(page).drawColor(Color.WHITE)
            }
            val canvas = Canvas(page!!)

            // 1) Markers: painted on a white layer, then multiplied so the text stays readable.
            val markers = if (spec.hasKey("markers")) spec.getArray("markers") else null
            var markerCount = 0
            if (markers != null && markers.size() > 0) {
                val layer = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                val lc = Canvas(layer)
                lc.drawColor(Color.WHITE)
                val mp = Paint(Paint.ANTI_ALIAS_FLAG)
                mp.style = Paint.Style.FILL
                for (i in 0 until markers.size()) {
                    val m = markers.getMap(i) ?: continue
                    mp.color = greyOf(m.getInt("grey"))
                    lc.drawPath(pathOf(m.getArray("polys"), scale), mp)
                    markerCount++
                }
                multiplyOnto(page, layer)
                layer.recycle()
            }

            // 2) Pens / pencils / calligraphy / shapes: opaque, on top.
            val pens = if (spec.hasKey("pens")) spec.getArray("pens") else null
            var penCount = 0
            if (pens != null) {
                val pp = Paint(Paint.ANTI_ALIAS_FLAG)
                pp.style = Paint.Style.FILL
                for (i in 0 until pens.size()) {
                    val m = pens.getMap(i) ?: continue
                    pp.color = greyOf(m.getInt("grey"))
                    canvas.drawPath(pathOf(m.getArray("polys"), scale), pp)
                    penCount++
                }
            }

            // 3) Append to the PDF
            val ptPerPx = if (spec.hasKey("pointsPerPx")) spec.getDouble("pointsPerPx").toFloat() else (72f / 226f) / scale
            doc.addPage(page, w * ptPerPx, h * ptPerPx)

            val res = Arguments.createMap()
            res.putBoolean("baseOk", baseOk)
            res.putInt("markers", markerCount)
            res.putInt("pens", penCount)
            res.putInt("width", w)
            res.putInt("height", h)
            res.putInt("pages", doc.pageCount)
            promise.resolve(res)
        } catch (e: Throwable) {
            promise.reject("ADD_PAGE", e.message ?: e.toString(), e)
        } finally {
            page?.recycle()
        }
    }

    /** Close the PDF and copy it to `dest`. The temporary file is removed. */
    @ReactMethod
    fun finishPdf(dest: String, promise: Promise) {
        val doc = pdf
        val tmp = tmpPath
        if (doc == null || tmp == null) {
            promise.reject("NO_PDF", "beginPdf was not called")
            return
        }
        try {
            val pages = doc.pageCount
            doc.finish()
            pdf = null
            val src = File(tmp)
            val out = File(dest)
            out.parentFile?.mkdirs()
            FileInputStream(src).use { input ->
                FileOutputStream(out).use { output -> input.copyTo(output, 1 shl 16) }
            }
            src.delete()
            val res = Arguments.createMap()
            res.putString("path", dest)
            res.putInt("pages", pages)
            res.putDouble("bytes", out.length().toDouble())
            promise.resolve(res)
        } catch (e: Throwable) {
            doc.abort()
            pdf = null
            promise.reject("FINISH", e.message ?: e.toString(), e)
        }
    }

    @ReactMethod
    fun abortPdf(promise: Promise) {
        try { pdf?.abort() } catch (_: Throwable) {}
        pdf = null
        promise.resolve(true)
    }

    /** Remove one of this plugin's own temporary files (names start with "epx_"). */
    @ReactMethod
    fun deleteTemp(path: String, promise: Promise) {
        try {
            val f = File(path)
            promise.resolve(f.name.startsWith("epx_") && f.delete())
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun fileExists(path: String, promise: Promise) {
        try { promise.resolve(File(path).exists()) } catch (e: Throwable) { promise.resolve(false) }
    }
}

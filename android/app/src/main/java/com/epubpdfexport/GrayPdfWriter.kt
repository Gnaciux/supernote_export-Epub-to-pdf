package com.epubpdfexport

import android.graphics.Bitmap
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream

/**
 * Minimal PDF writer: one full-page 8-bit greyscale image per page,
 * Flate-compressed (lossless), streamed to disk page by page.
 *
 * Why not android.graphics.pdf.PdfDocument: it stores each page as a
 * 32-bit RGB image and compresses it slowly. An e-ink page is greyscale,
 * so 8 bits per pixel is lossless here, 3x less data to compress, and the
 * file is much smaller.
 */
class GrayPdfWriter(private val file: File) {

    private class CountingStream(private val out: OutputStream) : OutputStream() {
        var count = 0L
            private set
        override fun write(b: Int) { out.write(b); count++ }
        override fun write(b: ByteArray, off: Int, len: Int) { out.write(b, off, len); count += len }
        override fun flush() = out.flush()
        override fun close() = out.close()
    }

    private val out = CountingStream(BufferedOutputStream(FileOutputStream(file), 1 shl 16))
    private val offsets = ArrayList<Long>()   // offsets[i] = byte offset of object i+1
    private val pageIds = ArrayList<Int>()
    private var closed = false

    init {
        // Objects 1 (catalog) and 2 (pages) are written at the end; reserve their numbers.
        offsets.add(0L)
        offsets.add(0L)
        out.write("%PDF-1.4\n%âãÏÓ\n".toByteArray(Charsets.ISO_8859_1))
    }

    private fun ascii(s: String) = out.write(s.toByteArray(Charsets.ISO_8859_1))

    private fun beginObject(): Int {
        offsets.add(out.count)
        val id = offsets.size
        ascii("$id 0 obj\n")
        return id
    }

    private fun setObjectOffset(id: Int) {
        offsets[id - 1] = out.count
        ascii("$id 0 obj\n")
    }

    /** Append one page. widthPt/heightPt are the page size in PDF points. */
    fun addPage(bitmap: Bitmap, widthPt: Float, heightPt: Float) {
        val w = bitmap.width
        val h = bitmap.height

        // 1) ARGB -> 8-bit luminance, deflated row by row.
        val compressed = ByteArrayOutputStream(w * h / 6)
        val deflater = Deflater(6)
        DeflaterOutputStream(compressed, deflater, 1 shl 16).use { z ->
            val row = IntArray(w)
            val grey = ByteArray(w)
            for (y in 0 until h) {
                bitmap.getPixels(row, 0, w, 0, y, w, 1)
                for (x in 0 until w) {
                    val c = row[x]
                    val r = (c shr 16) and 0xFF
                    val g = (c shr 8) and 0xFF
                    val b = c and 0xFF
                    grey[x] = ((r * 299 + g * 587 + b * 114) / 1000).toByte()
                }
                z.write(grey)
            }
        }
        deflater.end()

        // 2) Image XObject
        val imgId = beginObject()
        ascii("<< /Type /XObject /Subtype /Image /Width $w /Height $h /ColorSpace /DeviceGray " +
              "/BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.size()} >>\nstream\n")
        compressed.writeTo(out)
        ascii("\nendstream\nendobj\n")

        // 3) Content stream: draw the image over the whole page
        val wp = fmt(widthPt)
        val hp = fmt(heightPt)
        val content = "q $wp 0 0 $hp 0 0 cm /Im0 Do Q\n"
        val contentId = beginObject()
        ascii("<< /Length ${content.length} >>\nstream\n$content\nendstream\nendobj\n")

        // 4) Page
        val pageId = beginObject()
        ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 $wp $hp] " +
              "/Resources << /XObject << /Im0 $imgId 0 R >> >> /Contents $contentId 0 R >>\nendobj\n")
        pageIds.add(pageId)
    }

    val pageCount: Int get() = pageIds.size

    fun finish(): Long {
        setObjectOffset(2)
        ascii("<< /Type /Pages /Count ${pageIds.size} /Kids [${pageIds.joinToString(" ") { "$it 0 R" }}] >>\nendobj\n")
        setObjectOffset(1)
        ascii("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        val infoId = beginObject()
        ascii("<< /Producer (Exportar EPUB a PDF - Supernote plugin) >>\nendobj\n")

        val xref = out.count
        ascii("xref\n0 ${offsets.size + 1}\n0000000000 65535 f \n")
        for (o in offsets) ascii(String.format(java.util.Locale.US, "%010d 00000 n \n", o))
        ascii("trailer\n<< /Size ${offsets.size + 1} /Root 1 0 R /Info $infoId 0 R >>\nstartxref\n$xref\n%%EOF\n")
        out.flush()
        out.close()
        closed = true
        return file.length()
    }

    fun abort() {
        if (!closed) {
            try { out.close() } catch (_: Throwable) {}
            closed = true
        }
        try { file.delete() } catch (_: Throwable) {}
    }

    private fun fmt(v: Float): String {
        val r = Math.round(v * 100f) / 100f
        return if (r == r.toLong().toFloat()) r.toLong().toString() else r.toString()
    }
}

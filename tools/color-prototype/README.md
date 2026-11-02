# Restore EPUB colours — prototype (not in the plugin yet)

The Supernote renders EPUB pages in greyscale (generateCurrentDocImage returns grey
pixels only), so colour illustrations come out grey. The original colour images are
still inside the EPUB file. This prototype puts them back.

## How it works
1. Open the EPUB (a zip) and keep only images with real colour (>= 3 % chromatic
   pixels on a 64x64 thumbnail). Grey images need nothing.
2. On each grey page, find candidate image regions (bounding box of all non-white
   content + large connected components), at 1/4 resolution.
3. Match each candidate against the colour images: aspect ratio within 15 %, then
   normalised cross-correlation (accept >= 0.70).
4. Place the image: uniform scale searched around the bounding-box estimate
   (+-4 %, 17 steps, 9 anchors), refined by NCC at 1/4 and then 1/2 resolution.
5. Paste the colour pixels where they agree with the grey page (|delta lum| <= 100);
   the handwriting is drawn on top afterwards, so it is never covered.

## Result on "Cartas a un joven poeta" (Rilke, 91 pages, Manta 1920x2560)
13/13 illustrated pages matched (cover, 10 plates, last plate, author photo),
placement fit 0.98-1.00, about 1 s per illustrated page in Python.

## To ship it
- Port to Kotlin in EpubPdfRendererModule (java.util.zip + BitmapFactory).
- GrayPdfWriter: write DeviceRGB images for pages that received colour, keep
  DeviceGray for the rest.
- Optional switch in the dialog: "Restore EPUB colours" (on by default for EPUB).
- Limits: DRM-protected EPUBs cannot be read; heavily cropped images may not match
  (they simply stay grey).

Run: python3 colorize.py book.epub pages_dir out_dir   (pages_dir = grey page PNGs)

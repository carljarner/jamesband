# Party band website — build plan

## Overview

A two-part site:
- **Public page** — videos, setlist, prices, contact. Static content, nothing special needed here.
- **Intern page** (gated, band-only) — three tools that build on each other:
  1. Setlist order generator (Google Doc → ordered PDF)
  2. Scan cleanup pipeline (handwritten pencil chart photo → clean PDF)
  3. Chord library & transposition system (the main event)

This doc is the spec/handoff for building it in Claude Code. Sections below are roughly in build order.

---

## Feature 1: Setlist order generator

**Input:** a view-only Google Doc link to the master song book (one song per page).

**Pipeline:**
1. Export the doc as PDF via the Drive export API (`files.export`, mimeType `application/pdf`). Requires the doc's sharing settings to allow viewers to download/print/copy — if the owner has that disabled, export will fail, so check for it.
2. Maintain a `{song_title: page_number}` mapping for the master doc (rebuild whenever the doc's page order/content changes — could be a manual "resync" button rather than automatic, since the doc changes rarely).
3. Intern page UI: drag-and-drop list of song titles to build tonight's order.
4. Reorder + merge pages using `pypdf` (Python) or `pdf-lib` (JS) — pull pages by number in the chosen order, write out a new PDF.
5. Download.

This avoids re-parsing text/chord formatting entirely — it just reshuffles existing PDF pages, so nothing about the master doc's formatting needs to be constrained beyond "one song per page."

---

## Feature 2: Scan cleanup pipeline

**Goal:** phone photo of a handwritten pencil chart → clean, high-contrast, print-ready PDF.

Already prototyped and validated end-to-end on a real chart. Steps:
1. Fix EXIF rotation (`ImageOps.exif_transpose`) — phone photos are often stored sideways with an orientation flag.
2. Auto-crop to the paper: grayscale, find the bounding box where row/column mean brightness exceeds a threshold (paper is much brighter than a wood/table background).
3. Denoise (`cv2.bilateralFilter`) to reduce paper-grain speckle before thresholding.
4. Adaptive Gaussian threshold (`cv2.adaptiveThreshold`) to binarize — handles uneven lighting far better than a single global threshold, and turns grey pencil into solid black on pure white.
5. Small morphological close (2×2 kernel) to reconnect faint/broken pencil strokes.
6. Trim ~18px from each edge to drop any leftover shadow/table line the crop missed.
7. Embed into an A4 PDF (`reportlab`, `drawImage`, centered and scaled to fit).

This becomes a reusable function: `clean_scan(image_bytes) -> pdf_bytes`. See the appendix for the working code.

---

## Feature 3: Chord library & transposition system

The core idea: **don't recognize handwriting with AI — tag it once, by hand, and do transposition as image lookup + compositing.** Far more reliable than OCR on messy pencil, and it's a one-time cost per song since you're adding the song to the system anyway.

### 3a. Chord library (write once)

- Print a gridded recording sheet — one labeled box per chord to write in. I generated a first version of this sheet; regenerate/extend it as needed.
- Cover 12 roots × the qualities you actually use: major (no suffix), m, 7, m7, maj7, dim, sus4, 6 to start — extend later the same way if a song needs something new.
- Separately: 12 bare note-letter glyphs (A, A#, B, C...) + one "/" glyph. Slash chords are composed at render time as `[root+quality image] + [/] + [bass-letter image]` rather than needing a pre-written token for every possible slash combination (there are 1000+ theoretical ones — not writing all of those).
- Scan flat (flatbed, or a scanning app with deskew) — geometric accuracy matters here more than for everyday charts, since grid-slicing depends on knowing where each cell actually is.
- Auto-cropper: since the sheet's grid coordinates are known at generation time, a script slices the scanned sheet into one image per cell, named by chord, running each cell through the same cleanup pipeline as Feature 2.

### 3b. Per-song template (tag once, when adding a song)

- Upload the cleaned scan (Feature 2's output).
- Tagging UI: click each chord occurrence, pick its name from the library dropdown. This simultaneously:
  - Records `{chord_name, x, y}` (and ideally a baseline y, for consistent vertical alignment)
  - Paints white over that region in the background image
- Output per song: `background.png` (everything except chords — bar lines, section boxes, rhythm notation, all untouched) + `chords.json` (the position list).

### 3c. Transpose engine

- Input: song template + target interval (semitones) or target key.
- For each tagged chord: parse root (+ quality, + bass note if a slash chord) → shift root(s) by the interval using a 12-tone pitch-class table → look up the new chord's image in the library (composing slash chords as above) → paste onto the background at the tag's position, left-aligned at baseline (don't stretch to fit — let width vary naturally like real handwriting does).
- If a needed chord isn't in the library yet: flag it clearly (e.g. list "missing: C#m7" at the top of the output) rather than silently failing or falling back to a mismatched font.
- Export the composited image to PDF via the same function from Feature 2.

---

## Suggested tech stack

- Backend: Python (Pillow, OpenCV, reportlab, pypdf — all already used in the prototype) or Node equivalents if you'd rather keep one language with the frontend.
- Frontend: whatever's comfortable — the tagging UI is the only genuinely interactive piece (click-to-place points on an image, small dropdown per click).
- Storage: chord library images + song templates + tag JSON can start as flat files in a directory structure; no need for a database until the song list gets large.
- Auth: simple shared password or per-band-member login for the intern page — doesn't need to be fancy.

## Data model (sketch)

```json
// chord library entry
{
  "name": "Bm7",
  "root": "B",
  "quality": "m7",
  "bass": null,
  "image": "library/Bm7.png",
  "baseline_offset": 18
}

// song template
{
  "song": "Kom Tilbage Nu",
  "key": "Am",
  "background": "songs/kom-tilbage-nu/background.png",
  "chords": [
    { "chord": "Am", "x": 120, "y": 340 },
    { "chord": "F",  "x": 210, "y": 340 },
    { "chord": "G",  "x": 300, "y": 340 }
  ]
}
```

## Build phases

1. Static public page (video embeds, setlist display, prices, contact)
2. Setlist order generator
3. Scan cleanup pipeline (port the validated prototype in — see appendix)
4. Chord library: recording sheet generator + auto-cropper for the filled-in scan
5. Song tagging UI
6. Transpose engine + export
7. Polish: mobile-friendly intern page, quick access on gig day

## Open decisions to settle early

- Sharps vs. flats spelling convention (recommend picking one, e.g. always sharps, to avoid enharmonic-spelling logic)
- Which qualities go in v1 of the chord library (start smaller, extend as songs demand it)
- Auth approach for the intern page
- Hosting (static + serverless functions vs. a small Node/Python backend)

---

## Appendix: validated scan-cleanup code

```python
from PIL import Image, ImageOps
import numpy as np
import cv2

def clean_scan(input_path: str, output_path: str):
    img = Image.open(input_path)
    img = ImageOps.exif_transpose(img)  # fix phone-photo rotation
    gray_pil = img.convert("L")
    arr = np.array(gray_pil, dtype=np.float32)

    # Auto-crop to the paper (paper is much brighter than a wood/table background)
    row_means = arr.mean(axis=1)
    col_means = arr.mean(axis=0)
    thresh = 150
    rows = np.where(row_means > thresh)[0]
    cols = np.where(col_means > thresh)[0]
    pad = -6  # crop slightly inside the detected edge to drop border shadow
    top = max(0, rows[0] - pad)
    left = max(0, cols[0] - pad)
    bottom = min(arr.shape[0]-1, rows[-1] + pad)
    right = min(arr.shape[1]-1, cols[-1] + pad)
    cropped = gray_pil.crop((left, top, right, bottom))
    cropped_np = np.array(cropped)

    # Denoise, then adaptive threshold to binarize (pencil -> black, paper -> white)
    denoised = cv2.bilateralFilter(cropped_np, d=7, sigmaColor=35, sigmaSpace=35)
    binarized = cv2.adaptiveThreshold(
        denoised, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=51, C=10
    )

    # Reconnect faint/broken strokes
    kernel = np.ones((2, 2), np.uint8)
    closed = cv2.morphologyEx(binarized, cv2.MORPH_CLOSE, kernel, iterations=1)

    # Trim leftover edge shadow
    h, w = closed.shape
    m = 18
    trimmed = closed[m:h-m, m:w-m]
    cv2.imwrite(output_path, trimmed)
    return output_path
```

```python
# Embedding into an A4 PDF
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image

def image_to_pdf(image_path: str, pdf_path: str):
    img = Image.open(image_path)
    img_w, img_h = img.size
    page_w, page_h = A4
    margin = 20
    avail_w, avail_h = page_w - 2*margin, page_h - 2*margin
    scale = min(avail_w / img_w, avail_h / img_h)
    draw_w, draw_h = img_w * scale, img_h * scale
    x, y = (page_w - draw_w) / 2, (page_h - draw_h) / 2

    c = canvas.Canvas(pdf_path, pagesize=A4)
    c.drawImage(image_path, x, y, width=draw_w, height=draw_h)
    c.save()
```

```python
# Transposition: shifting a chord's root by N semitones
NOTES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]

def transpose_root(root: str, semitones: int) -> str:
    idx = NOTES.index(root)
    return NOTES[(idx + semitones) % 12]

# e.g. parse "Bm7" -> root "B", quality "m7"; parse "B7/D#" -> root "B", quality "7", bass "D#"
# shift each note component independently with transpose_root, then look up
# f"{new_root}{quality}" (and f"{new_bass}") in the chord library
```

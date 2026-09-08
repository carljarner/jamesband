"""Feature 2: scan cleanup pipeline.

Phone photo of a handwritten pencil chart -> clean, high-contrast,
print-ready PDF. Stateless (no data_store writes): output is built
in-memory and returned straight to the caller.

clean_array() and embed_image_in_a4_pdf() are also reused by chords.py --
the chord-library recording sheet and per-song scans go through the same
crop/denoise/binarize pipeline and the same PDF embedding before anything
sheet- or song-specific happens.
"""

from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageOps
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


class CleanupError(Exception):
    """Raised when the uploaded photo can't be turned into a clean chart."""


def clean_array(image_bytes: bytes, edge_trim: int = 18) -> np.ndarray:
    """Crop to the paper, denoise and binarize. Returns a grayscale (0/255) array.

    `edge_trim` drops a fixed border to clean up phone-photo table shadow the
    paper-boundary crop missed; pass 0 for a flatbed/scanning-app source
    (chords.py's recording-sheet import), where there's no such shadow and a
    fixed trim would otherwise throw off proportional grid-cell math.
    """
    try:
        img = Image.open(BytesIO(image_bytes))
        img.load()
    except Exception as exc:
        raise CleanupError("Couldn't read that as an image.") from exc

    img = ImageOps.exif_transpose(img)  # fix phone-photo rotation
    gray_pil = img.convert("L")
    arr = np.array(gray_pil, dtype=np.float32)

    # Auto-crop to the paper (paper is much brighter than a wood/table background)
    row_means = arr.mean(axis=1)
    col_means = arr.mean(axis=0)
    thresh = 150
    rows = np.where(row_means > thresh)[0]
    cols = np.where(col_means > thresh)[0]
    if len(rows) == 0 or len(cols) == 0:
        raise CleanupError("Couldn't find the paper in that photo -- try better lighting.")

    pad = -6  # crop slightly inside the detected edge to drop border shadow
    top = max(0, rows[0] - pad)
    left = max(0, cols[0] - pad)
    bottom = min(arr.shape[0] - 1, rows[-1] + pad)
    right = min(arr.shape[1] - 1, cols[-1] + pad)
    cropped = gray_pil.crop((left, top, right, bottom))
    cropped_np = np.array(cropped)

    # Denoise, then adaptive threshold to binarize (pencil -> black, paper -> white)
    denoised = cv2.bilateralFilter(cropped_np, d=7, sigmaColor=35, sigmaSpace=35)
    binarized = cv2.adaptiveThreshold(
        denoised, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=51, C=10,
    )

    # Reconnect faint/broken pencil strokes
    kernel = np.ones((2, 2), np.uint8)
    closed = cv2.morphologyEx(binarized, cv2.MORPH_CLOSE, kernel, iterations=1)

    # Trim leftover edge shadow the crop missed
    h, w = closed.shape
    m = edge_trim
    if h <= 2 * m or w <= 2 * m:
        raise CleanupError("That photo is too small/cropped -- try retaking it.")
    return closed[m:h - m, m:w - m] if m else closed


def embed_image_in_a4_pdf(image: Image.Image) -> bytes:
    """Center an image on an A4 page, scaled to fit, and return PDF bytes."""
    img_w, img_h = image.size
    page_w, page_h = A4
    margin = 20
    avail_w, avail_h = page_w - 2 * margin, page_h - 2 * margin
    scale = min(avail_w / img_w, avail_h / img_h)
    draw_w, draw_h = img_w * scale, img_h * scale
    x, y = (page_w - draw_w) / 2, (page_h - draw_h) / 2

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawImage(ImageReader(image), x, y, width=draw_w, height=draw_h)
    c.save()
    return buf.getvalue()


def clean_scan(image_bytes: bytes) -> bytes:
    """Clean up a phone photo of a handwritten chart and return an A4 PDF."""
    trimmed = clean_array(image_bytes)
    ok, encoded = cv2.imencode(".png", trimmed)
    if not ok:
        raise CleanupError("Couldn't encode the cleaned image.")
    return embed_image_in_a4_pdf(Image.open(BytesIO(encoded.tobytes())))

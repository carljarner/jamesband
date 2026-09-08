"""Feature 3: chord library & transposition.

Core idea: don't recognize handwriting with AI -- tag each chord's position
once, by hand, when a song is added, and do transposition as image lookup
+ compositing. A chord library is built the same way: print a gridded
recording sheet, fill it in by hand, scan it flat, and slice it into one
image per chord using the sheet's known (proportional) grid geometry.

Slash chords (e.g. "B7/D#") aren't pre-written as whole tokens -- there are
1000+ theoretical combinations. They're composed at render time from three
pieces: the root+quality image, a "/" glyph, and a bare bass-letter glyph.
"""

import re
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas as pdf_canvas

import data_store
import scan_cleanup

ROOTS = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
QUALITIES = ["", "m", "7", "m7", "maj7", "dim", "sus4", "6"]

CHORD_LABELS = [f"{root}{quality}" for quality in QUALITIES for root in ROOTS]
LETTER_LABELS = ROOTS + ["/"]
# Sheet layout shared by the PDF generator and the scan importer: which
# labels go on a sheet, and how many columns wide the grid is.
SHEET_LAYOUTS = {
    "chords": (CHORD_LABELS, len(ROOTS)),
    "letters": (LETTER_LABELS, len(LETTER_LABELS)),
}

LIBRARY_DIR = "chord_library"
LIBRARY_PATH = f"{LIBRARY_DIR}/library.json"
SONG_INDEX_PATH = "songs/index.json"

MARGIN = 30  # pt, recording-sheet page margin on all sides
LABEL_STRIP_FRAC = 0.22  # fraction of a cell's height reserved for the printed label

_QUALITY_PATTERN = "|".join(sorted((q for q in QUALITIES if q), key=len, reverse=True))
CHORD_NAME_RE = re.compile(
    rf"^(?P<root>[A-G]#?)(?P<quality>{_QUALITY_PATTERN})?(?:/(?P<bass>[A-G]#?))?$"
)


class ChordError(Exception):
    """Raised for chord parsing, library-lookup, or transposition problems."""


# ---------------------------------------------------------------------------
# Chord name parsing & transposition
# ---------------------------------------------------------------------------

def parse_chord(name: str) -> tuple[str, str, str | None]:
    match = CHORD_NAME_RE.match(name.strip())
    if not match:
        raise ChordError(f"Can't parse chord name '{name}'.")
    return match.group("root"), match.group("quality") or "", match.group("bass")


def transpose_note(note: str, semitones: int) -> str:
    return ROOTS[(ROOTS.index(note) + semitones) % 12]


def transpose_chord_name(name: str, semitones: int) -> str:
    root, quality, bass = parse_chord(name)
    new_name = f"{transpose_note(root, semitones)}{quality}"
    if bass:
        new_name += f"/{transpose_note(bass, semitones)}"
    return new_name


def semitones_for_target_key(from_key: str, to_key: str) -> int:
    from_root, _, _ = parse_chord(from_key)
    to_root, _, _ = parse_chord(to_key)
    return (ROOTS.index(to_root) - ROOTS.index(from_root)) % 12


# ---------------------------------------------------------------------------
# Recording sheet: shared grid geometry, PDF generation, scan import
# ---------------------------------------------------------------------------

def _cell_fractions(count: int, cols: int, page_size: tuple[float, float]):
    """(top, left, bottom, right) fractions of the page, top-down, for each
    of `count` cells arranged row-major in `cols` columns. Shared by the PDF
    generator and the scan slicer so their geometry can never drift apart."""
    page_w, page_h = page_size
    rows = -(-count // cols)  # ceil
    cell_w = (page_w - 2 * MARGIN) / cols
    cell_h = (page_h - 2 * MARGIN) / rows
    cells = []
    for i in range(count):
        row, col = divmod(i, cols)
        top = (MARGIN + row * cell_h) / page_h
        bottom = (MARGIN + (row + 1) * cell_h) / page_h
        left = (MARGIN + col * cell_w) / page_w
        right = (MARGIN + (col + 1) * cell_w) / page_w
        cells.append((top, left, bottom, right))
    return cells


def _draw_grid_page(c, labels, cols, page_size):
    page_w, page_h = page_size
    c.setFont("Helvetica", 8)
    for label, (top, left, bottom, right) in zip(labels, _cell_fractions(len(labels), cols, page_size)):
        x0, x1 = left * page_w, right * page_w
        y0, y1 = page_h - bottom * page_h, page_h - top * page_h  # PDF y grows upward
        c.rect(x0, y0, x1 - x0, y1 - y0)
        c.drawString(x0 + 3, y1 - 11, label)


def generate_recording_sheet() -> bytes:
    """Printable PDF: one labeled box per chord/letter to hand-write into."""
    page_size = landscape(A4)
    buf = BytesIO()
    c = pdf_canvas.Canvas(buf, pagesize=page_size)

    _draw_grid_page(c, CHORD_LABELS, cols=len(ROOTS), page_size=page_size)
    c.showPage()
    _draw_grid_page(c, LETTER_LABELS, cols=len(LETTER_LABELS), page_size=page_size)
    c.save()
    return buf.getvalue()


def _crop_to_ink(cell: np.ndarray, pad: int = 4) -> np.ndarray | None:
    """Tightly crop a cell to its handwritten ink, or None if it's blank.

    Keeps chord widths natural (like real handwriting) instead of stretching
    every glyph to fill a uniform grid cell.
    """
    ink = cell < 128
    if ink.sum() < 15:
        return None
    rows = np.where(ink.any(axis=1))[0]
    cols = np.where(ink.any(axis=0))[0]
    top = max(0, rows[0] - pad)
    bottom = min(cell.shape[0], rows[-1] + pad + 1)
    left = max(0, cols[0] - pad)
    right = min(cell.shape[1], cols[-1] + pad + 1)
    return cell[top:bottom, left:right]


CELL_INSET_FRAC = 0.10  # shrink each cell before ink-cropping, to exclude the printed border


def _slice_cells(arr: np.ndarray, labels, cols, page_size) -> dict[str, np.ndarray]:
    h, w = arr.shape
    out = {}
    for label, (top, left, bottom, right) in zip(labels, _cell_fractions(len(labels), cols, page_size)):
        top += LABEL_STRIP_FRAC * (bottom - top)  # skip the printed label strip
        y0, y1 = int(top * h), int(bottom * h)
        x0, x1 = int(left * w), int(right * w)
        inset_y, inset_x = int((y1 - y0) * CELL_INSET_FRAC), int((x1 - x0) * CELL_INSET_FRAC)
        glyph = _crop_to_ink(arr[y0 + inset_y:y1 - inset_y, x0 + inset_x:x1 - inset_x])
        if glyph is not None:
            out[label] = glyph
    return out


def _safe_name(label: str) -> str:
    return (label.replace("#", "s").replace("/", "slash")) or "blank"


def _save_png(rel_path: str, arr: np.ndarray) -> None:
    path = data_store.DATA_DIR / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(".png", arr)
    if not ok:
        raise ChordError("Couldn't encode an image for storage.")
    path.write_bytes(encoded.tobytes())


def _load_library() -> dict:
    return data_store.load_json(LIBRARY_PATH, default={})


def _save_library(library: dict) -> None:
    data_store.save_json(LIBRARY_PATH, library)


def import_library_sheet(image_bytes: bytes, kind: str) -> list[str]:
    """Slice a scanned, filled-in recording sheet into named chord/letter
    images and merge newly-filled-in ones into the library. Cells left
    blank are skipped, so a partial re-scan never erases existing entries.
    """
    if kind not in SHEET_LAYOUTS:
        raise ChordError(f"Unknown sheet kind '{kind}'.")
    labels, cols = SHEET_LAYOUTS[kind]
    # edge_trim=0: this is a flatbed/scanning-app source with no table shadow
    # to trim, and a fixed trim would throw off the proportional grid math.
    arr = scan_cleanup.clean_array(image_bytes, edge_trim=0)
    glyphs = _slice_cells(arr, labels, cols, landscape(A4))

    library = _load_library()
    section = library.setdefault(kind, {})
    for name, glyph in glyphs.items():
        rel_path = f"{LIBRARY_DIR}/{kind}/{_safe_name(name)}.png"
        _save_png(rel_path, glyph)
        section[name] = rel_path
    _save_library(library)

    if glyphs:
        data_store.commit_and_push(
            f"Import {len(glyphs)} chord library entr{'y' if len(glyphs) == 1 else 'ies'} ({kind})"
        )
    return sorted(glyphs)


def library_status() -> dict:
    library = _load_library()
    return {
        kind: [{"name": name, "have": name in library.get(kind, {})} for name in labels]
        for kind, (labels, _cols) in SHEET_LAYOUTS.items()
    }


def library_image_path(kind: str, name: str):
    library = _load_library()
    rel_path = library.get(kind, {}).get(name)
    return data_store.DATA_DIR / rel_path if rel_path else None


def _library_image(kind: str, name: str) -> Image.Image:
    path = library_image_path(kind, name)
    if not path or not path.exists():
        raise ChordError(name)
    return Image.open(path).convert("L")


def compose_chord_image(name: str) -> Image.Image:
    """Look up (or, for slash chords, build) the glyph image for a chord
    name. Raises ChordError(<missing piece>) if any piece isn't in the
    library yet.
    """
    root, quality, bass = parse_chord(name)
    main = _library_image("chords", f"{root}{quality}")
    if not bass:
        return main

    slash = _library_image("letters", "/")
    bass_img = _library_image("letters", bass)

    gap = 4
    height = max(main.height, slash.height, bass_img.height)
    total_w = main.width + gap + slash.width + gap + bass_img.width
    composed = Image.new("L", (total_w, height), 255)
    x = 0
    for piece in (main, slash, bass_img):
        composed.paste(piece, (x, height - piece.height))  # baseline-align at the bottom
        x += piece.width + gap
    return composed


# ---------------------------------------------------------------------------
# Song templates: upload -> tag -> transpose
# ---------------------------------------------------------------------------

def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.strip().lower()).strip("-")
    if not slug:
        raise ChordError("Song title can't be empty.")
    return slug


def list_songs() -> list[dict]:
    return data_store.load_json(SONG_INDEX_PATH, default=[])


def get_song(slug: str) -> dict | None:
    return data_store.load_json(f"songs/{slug}/chords.json")


def song_image_path(slug: str, which: str):
    if which not in ("original", "background"):
        return None
    path = data_store.DATA_DIR / "songs" / slug / f"{which}.png"
    return path if path.exists() else None


def create_song_draft(title: str, key: str, image_bytes: bytes) -> str:
    slug = slugify(title)
    parse_chord(key)  # fail fast on an unparseable key rather than at transpose time
    arr = scan_cleanup.clean_array(image_bytes)
    _save_png(f"songs/{slug}/original.png", arr)
    data_store.save_json(f"songs/{slug}/chords.json", {
        "song": title, "key": key, "chords": [], "tagged": False,
    })

    index = [s for s in list_songs() if s["slug"] != slug]
    index.append({"slug": slug, "song": title, "key": key, "tagged": False})
    data_store.save_json(SONG_INDEX_PATH, index)
    data_store.commit_and_push(f"Add song draft '{title}'")
    return slug


def save_song_tags(slug: str, chords_in: list[dict]) -> None:
    song = get_song(slug)
    if not song:
        raise ChordError(f"Unknown song '{slug}'.")

    clean_tags = []
    for tag in chords_in:
        try:
            name = str(tag["chord"]).strip()
            parse_chord(name)  # validate now, before it's baked into the file
            clean_tags.append({
                "chord": name,
                "x": int(tag["x"]), "y": int(tag["y"]),
                "w": int(tag["w"]), "h": int(tag["h"]),
            })
        except (KeyError, ValueError, TypeError, ChordError) as exc:
            raise ChordError(f"Bad chord tag: {tag}") from exc

    original_path = data_store.DATA_DIR / "songs" / slug / "original.png"
    if not original_path.exists():
        raise ChordError("Missing scanned image for this song, re-upload it.")
    arr = cv2.imread(str(original_path), cv2.IMREAD_GRAYSCALE)

    background = arr.copy()
    for tag in clean_tags:
        y0, y1 = max(0, tag["y"]), min(background.shape[0], tag["y"] + tag["h"])
        x0, x1 = max(0, tag["x"]), min(background.shape[1], tag["x"] + tag["w"])
        background[y0:y1, x0:x1] = 255
    _save_png(f"songs/{slug}/background.png", background)

    song["chords"] = clean_tags
    song["tagged"] = True
    data_store.save_json(f"songs/{slug}/chords.json", song)

    index = list_songs()
    for entry in index:
        if entry["slug"] == slug:
            entry["tagged"] = True
    data_store.save_json(SONG_INDEX_PATH, index)
    data_store.commit_and_push(f"Tag chords for '{song['song']}'")


def _with_missing_banner(img: Image.Image, missing: list[str]) -> Image.Image:
    text = "Missing from library: " + ", ".join(sorted(set(missing)))
    font = ImageFont.load_default()
    banner_h = 28
    banner = Image.new("L", (img.width, banner_h), 255)
    draw = ImageDraw.Draw(banner)
    draw.rectangle((0, 0, img.width - 1, banner_h - 1), outline=0)
    draw.text((6, 6), text, fill=0, font=font)

    combined = Image.new("L", (img.width, img.height + banner_h), 255)
    combined.paste(banner, (0, 0))
    combined.paste(img, (0, banner_h))
    return combined


def transpose_song(slug: str, semitones: int) -> bytes:
    song = get_song(slug)
    if not song or not song.get("tagged"):
        raise ChordError("This song hasn't been tagged with chords yet.")

    bg_path = data_store.DATA_DIR / "songs" / slug / "background.png"
    canvas_img = Image.open(bg_path).convert("L").copy()

    missing = []
    for tag in song["chords"]:
        new_name = transpose_chord_name(tag["chord"], semitones)
        try:
            glyph = compose_chord_image(new_name)
        except ChordError:
            missing.append(f"{new_name} (was {tag['chord']})")
            continue
        baseline_y = tag["y"] + tag["h"]
        canvas_img.paste(glyph, (tag["x"], baseline_y - glyph.height))

    if missing:
        canvas_img = _with_missing_banner(canvas_img, missing)

    return scan_cleanup.embed_image_in_a4_pdf(canvas_img)

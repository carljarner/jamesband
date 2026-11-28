"""Lyrics as PDF pages, drawn like the Lyrics editor's A4 page
(static/lyrics-editor.js, .lyrics-sheet in style.css) under a header like
a gig lead sheet's (static/leadsheet-editor.js, renderSvg): the title and
artist centred, the singer top left, and the key top right with an arrow
for how far it's transposed. Then the lyrics in two columns, the left one
filling first. Section headings are bold and highlights keep their blue
or red.

Each song starts on a new page; lyrics too long for one page continue in
the next page's columns.

Fonts: the header is in MuseJazzText, like the editor's and the lead
sheets'. reportlab only embeds TrueType, so it uses
static/fonts/MuseJazzText.ttf, a TrueType conversion of the OTF the
browser uses. The lyrics are in Arial, or Liberation Sans (Arial's metrics,
installed in the Docker image) on the server; Helvetica if neither is
there.
"""

from functools import lru_cache
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer,
)

PX = 0.75  # one CSS px (a lead sheet's SVG unit) in points
PAGE_W, PAGE_H = A4
# The editor page's padding (30px 40px 40px).
TOP, SIDE, BOTTOM = 30 * PX, 40 * PX, 40 * PX
# Where the lyrics start on a song's first page, from the top of the
# page: under the title, the artist and the gap below them.
BODY_TOP = 100 * PX
COLUMN_GAP = 10 * mm
FONT_SIZE = 11
LEADING = FONT_SIZE * 1.25
HIGHLIGHTS = {"blue": "#c9e2ff", "red": "#ffcdcd"}

# The lead sheet's header (renderSvg): text 28px from the page's edges,
# the title, key and singer on one baseline and the artist under them.
HEAD_MARGIN = 28 * PX
HEAD_BASELINE = 47 * PX
ARTIST_BASELINE = 69 * PX
TITLE_SIZE, ARTIST_SIZE, KEY_SIZE = 22 * PX, 13 * PX, 15 * PX
HEAD_COLOR = HexColor("#1a1815")
DIM_COLOR = HexColor("#55504a")
TEXT_COLOR = HexColor("#111111")

FONTS_DIR = Path(__file__).parent / "static" / "fonts"
SANS_FILES = [
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
     "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
     "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
]


@lru_cache(maxsize=1)
def _fonts() -> dict:
    """The registered font names: "head" (MuseJazzText), "sans" and
    "bold" for the lyrics; "arrows" says whether "sans" has ↑ and ↓."""
    head = "Helvetica-Bold"
    try:
        pdfmetrics.registerFont(TTFont("MuseJazzText", str(FONTS_DIR / "MuseJazzText.ttf")))
        head = "MuseJazzText"
    except Exception:
        pass
    for regular, bold in SANS_FILES:
        if Path(regular).exists() and Path(bold).exists():
            pdfmetrics.registerFont(TTFont("LyricsSans", regular))
            pdfmetrics.registerFont(TTFont("LyricsSans-Bold", bold))
            return {"head": head, "sans": "LyricsSans", "bold": "LyricsSans-Bold", "arrows": True}
    return {"head": head, "sans": "Helvetica", "bold": "Helvetica-Bold", "arrows": False}


@lru_cache(maxsize=1)
def _styles() -> tuple[ParagraphStyle, ParagraphStyle]:
    fonts = _fonts()
    line = ParagraphStyle("line", fontName=fonts["sans"], fontSize=FONT_SIZE, leading=LEADING, textColor=TEXT_COLOR)
    section = ParagraphStyle(
        "section", parent=line, fontName=fonts["bold"], spaceBefore=FONT_SIZE * 0.9, keepWithNext=1
    )
    return line, section


def _run_markup(run: dict) -> str:
    # Like the editor (white-space: pre-wrap), runs of spaces are kept.
    text = escape(run["text"]).replace("  ", " \u00a0")
    color = HIGHLIGHTS.get(run.get("hl"))
    return f'<span backColor="{color}">{text}</span>' if color else text


def _block_flowable(block: dict):
    runs = [run for run in block.get("runs", []) if run.get("text")]
    if not "".join(run["text"] for run in runs).strip():
        return Spacer(1, LEADING)  # a blank line
    line, section = _styles()
    style = section if block.get("type") == "section" else line
    return Paragraph("".join(_run_markup(run) for run in runs), style)


def _fitted_size(text: str, font: str, size: float, width: float) -> float:
    """`size`, or smaller until `text` fits in `width`."""
    while size > 8 and pdfmetrics.stringWidth(text, font, size) > width:
        size -= 0.5
    return size


def _key_parts(key: str, semitones: int) -> list[tuple[str, bool]]:
    """The key label as the lead sheet writes it -- "Key: F", or transposed
    "Key: F (0.5 ↑)" in whole tones -- split into (text, is_arrow) parts,
    since MuseJazzText has no arrows (the browser borrows them too)."""
    if not semitones:
        return [(f"Key: {key}", False)]
    amount = f"{abs(semitones) / 2:g}"
    return [(f"Key: {key} ({amount} ", False), ("↑" if semitones > 0 else "↓", True), (")", False)]


class _SongHeader(Flowable):
    """Takes no room in the flow; draws a song's header at the top of the
    page it lands on (always the first page of its song)."""

    def __init__(self, song: dict):
        super().__init__()
        self.song = song
        self.width = self.height = 0

    def wrap(self, avail_width, avail_height):
        return 0, 0

    def _draw_key(self, canvas, fonts: dict, key: str, semitones: int) -> None:
        parts = _key_parts(key, semitones)
        arrow_font = fonts["sans"] if fonts["arrows"] else None

        def width(text, is_arrow):
            if is_arrow:
                return pdfmetrics.stringWidth(text, arrow_font, KEY_SIZE) if arrow_font else KEY_SIZE * 0.5
            return pdfmetrics.stringWidth(text, fonts["head"], KEY_SIZE)

        x = PAGE_W - HEAD_MARGIN - sum(width(*part) for part in parts)
        y = PAGE_H - HEAD_BASELINE
        for text, is_arrow in parts:
            w = width(text, is_arrow)
            if not is_arrow:
                canvas.setFont(fonts["head"], KEY_SIZE)
                canvas.drawString(x, y, text)
            elif arrow_font:
                canvas.setFont(arrow_font, KEY_SIZE)
                canvas.drawString(x, y, text)
            else:  # no font with arrows: draw one
                up = text == "↑"
                cx, low, high = x + w / 2, y, y + KEY_SIZE * 0.7
                tip, tail = (high, low) if up else (low, high)
                head = KEY_SIZE * 0.2 * (-1 if up else 1)
                canvas.setStrokeColor(DIM_COLOR)
                canvas.setLineWidth(0.8)
                canvas.line(cx, tail, cx, tip)
                canvas.line(cx - KEY_SIZE * 0.18, tip + head, cx, tip)
                canvas.line(cx + KEY_SIZE * 0.18, tip + head, cx, tip)
            x += w

    def drawOn(self, canvas, x, y, _sW=0):
        fonts = _fonts()
        title = str(self.song.get("title") or "")
        artist = str(self.song.get("artist") or "")
        key = str(self.song.get("key") or "")
        singer = str(self.song.get("singer") or "")
        # The title's column is the middle two thirds of the header, as in
        # the editor's grid.
        size = _fitted_size(title, fonts["head"], TITLE_SIZE, (PAGE_W - 2 * SIDE) * 2 / 3)
        canvas.saveState()
        canvas.setFillColor(HEAD_COLOR)
        canvas.setFont(fonts["head"], size)
        canvas.drawCentredString(PAGE_W / 2, PAGE_H - HEAD_BASELINE, title)
        canvas.setFillColor(DIM_COLOR)
        if artist:
            canvas.setFont(fonts["head"], ARTIST_SIZE)
            canvas.drawCentredString(PAGE_W / 2, PAGE_H - ARTIST_BASELINE, artist)
        if singer:
            canvas.setFont(fonts["head"], KEY_SIZE)
            canvas.drawString(HEAD_MARGIN, PAGE_H - HEAD_BASELINE, f"Singer: {singer}")
        if key:
            self._draw_key(canvas, fonts, key, int(self.song.get("semitones") or 0))
        canvas.restoreState()


def _frames(top: float, prefix: str) -> list[Frame]:
    width = (PAGE_W - 2 * SIDE - COLUMN_GAP) / 2
    height = top - BOTTOM
    return [
        Frame(SIDE + i * (width + COLUMN_GAP), BOTTOM, width, height, id=f"{prefix}{i}",
              leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        for i in range(2)
    ]


def build(songs: list[dict]) -> bytes:
    """A PDF of `songs` in order: each a lyrics doc's title, artist and
    blocks, plus the header's key, semitones (for the arrow; 0 for none)
    and singer (see gig_bundle._lyrics_page)."""
    buf = BytesIO()
    template = BaseDocTemplate(buf, pagesize=A4, title="Lyrics")
    template.addPageTemplates([
        PageTemplate(id="first", frames=_frames(PAGE_H - BODY_TOP, "first")),
        PageTemplate(id="more", frames=_frames(PAGE_H - TOP, "more")),
    ])
    story = []
    for index, song in enumerate(songs):
        if index:
            story += [NextPageTemplate("first"), PageBreak()]
        # Pages after a song's first continue its columns, without a header.
        story += [_SongHeader(song), NextPageTemplate("more")]
        blocks = list(song.get("blocks") or [])
        while blocks and not "".join(r.get("text", "") for r in blocks[-1].get("runs", [])).strip():
            blocks.pop()
        story += [_block_flowable(block) for block in blocks]
    template.build(story)
    return buf.getvalue()

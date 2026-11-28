"""Lyrics as PDF pages, drawn like the Lyrics editor's A4 page
(static/lyrics-editor.js, .lyrics-sheet in style.css): the title and
artist centred at the top with the key on the right, then the lyrics in
two columns, the left one filling first. Section headings are bold and
highlights keep their blue or red.

Each song starts on a new page; lyrics too long for one page continue in
the next page's columns. reportlab can't embed the MuseJazz OTF fonts the
editor's header uses, so everything is in Helvetica (close to the
editor's Arial).
"""

from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer,
)

PX = 0.75  # one CSS px in points
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

TITLE_FONT, TITLE_SIZE = "Helvetica-Bold", 22 * PX
ARTIST_SIZE = 13 * PX
KEY_SIZE = 15 * PX
HEAD_COLOR = HexColor("#1a1815")
DIM_COLOR = HexColor("#55504a")

LINE_STYLE = ParagraphStyle("line", fontName="Helvetica", fontSize=FONT_SIZE, leading=LEADING, textColor=HexColor("#111111"))
SECTION_STYLE = ParagraphStyle(
    "section", parent=LINE_STYLE, fontName="Helvetica-Bold", spaceBefore=FONT_SIZE * 0.9, keepWithNext=1
)


def _run_markup(run: dict) -> str:
    # Like the editor (white-space: pre-wrap), runs of spaces are kept.
    text = escape(run["text"]).replace("  ", " \u00a0")
    color = HIGHLIGHTS.get(run.get("hl"))
    return f'<span backColor="{color}">{text}</span>' if color else text


def _block_flowable(block: dict):
    runs = [run for run in block.get("runs", []) if run.get("text")]
    if not "".join(run["text"] for run in runs).strip():
        return Spacer(1, LEADING)  # a blank line
    style = SECTION_STYLE if block.get("type") == "section" else LINE_STYLE
    return Paragraph("".join(_run_markup(run) for run in runs), style)


def _fitted_size(text: str, font: str, size: float, width: float) -> float:
    """`size`, or smaller until `text` fits in `width`."""
    while size > 8 and stringWidth(text, font, size) > width:
        size -= 0.5
    return size


class _SongHeader(Flowable):
    """Takes no room in the flow; draws a song's header at the top of the
    page it lands on (always the first page of its song)."""

    def __init__(self, doc: dict, key: str):
        super().__init__()
        self.song = doc
        self.key = key
        self.width = self.height = 0

    def wrap(self, avail_width, avail_height):
        return 0, 0

    def drawOn(self, canvas, x, y, _sW=0):
        title = str(self.song.get("title") or "")
        artist = str(self.song.get("artist") or "")
        top = PAGE_H - TOP
        # The title's column is the middle two thirds of the header, as in
        # the editor's grid.
        size = _fitted_size(title, TITLE_FONT, TITLE_SIZE, (PAGE_W - 2 * SIDE) * 2 / 3)
        canvas.saveState()
        canvas.setFillColor(HEAD_COLOR)
        canvas.setFont(TITLE_FONT, size)
        canvas.drawCentredString(PAGE_W / 2, top - 19 * PX, title)
        if artist:
            canvas.setFillColor(DIM_COLOR)
            canvas.setFont("Helvetica", ARTIST_SIZE)
            canvas.drawCentredString(PAGE_W / 2, top - 41 * PX, artist)
        if self.key:
            canvas.setFillColor(DIM_COLOR)
            canvas.setFont("Helvetica", KEY_SIZE)
            # 28px from the page's edge, as on a lead sheet.
            canvas.drawRightString(PAGE_W - 28 * PX, top - 17 * PX, f"Key: {self.key}")
        canvas.restoreState()


def _frames(top: float, prefix: str) -> list[Frame]:
    width = (PAGE_W - 2 * SIDE - COLUMN_GAP) / 2
    height = top - BOTTOM
    return [
        Frame(SIDE + i * (width + COLUMN_GAP), BOTTOM, width, height, id=f"{prefix}{i}",
              leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        for i in range(2)
    ]


def build(songs: list[tuple[dict, str]]) -> bytes:
    """A PDF of `songs`, each (lyrics doc, key to show), in order."""
    buf = BytesIO()
    template = BaseDocTemplate(buf, pagesize=A4, title="Lyrics")
    template.addPageTemplates([
        PageTemplate(id="first", frames=_frames(PAGE_H - BODY_TOP, "first")),
        PageTemplate(id="more", frames=_frames(PAGE_H - TOP, "more")),
    ])
    story = []
    for index, (doc, key) in enumerate(songs):
        if index:
            story += [NextPageTemplate("first"), PageBreak()]
        # Pages after a song's first continue its columns, without a header.
        story += [_SongHeader(doc, key), NextPageTemplate("more")]
        blocks = list(doc.get("blocks") or [])
        while blocks and not "".join(r.get("text", "") for r in blocks[-1].get("runs", [])).strip():
            blocks.pop()
        story += [_block_flowable(block) for block in blocks]
    template.build(story)
    return buf.getvalue()

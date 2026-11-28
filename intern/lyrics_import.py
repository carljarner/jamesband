"""Importing lyrics from the band's old Google Doc, where every song sits
one after another under a big heading like "Treasure (Bbm)".

The doc is read through its HTML export (see setlist.fetch_doc_export), so
no Google credentials are needed. parse() turns it into one entry per song
in the block format lyrics.py stores; match() suggests the repertoire song
(or upcoming new song) each one belongs to. The Lyrics page shows that as a
list to check before anything is created.
"""

import colorsys
import difflib
import re
from html.parser import HTMLParser

import chords
import data_store
import setlist

CONFIG_PATH = "lyrics_import.json"
# The band's lyrics doc, filled in until another link has been used.
DEFAULT_DOC_URL = "https://docs.google.com/document/d/1rxfMtbQ1SLshTYYgneDEn3vpLcP7JbP-HhlmZ2HHrqw/edit?usp=sharing"

# A song starts at a heading at least this big; smaller headings are lyric
# lines formatted as headings by mistake.
SONG_HEADING_MIN_PT = 15.0
# Section headings ("vers", "Omk x 2", "[Bro]") are short lines.
SECTION_MAX_CHARS = 30
SECTION_WORDS = (
    "vers", "verse", "omk", "omkvæd", "omkvaed", "chorus", "pre", "prechorus", "pre-chorus",
    "bro", "bridge", "c-stykke", "c stykke", "cstykke", "intro", "outro", "solo", "mellemspil",
    "break", "hook", "refrain", "post", "kor", "interlude", "ending",
)
SECTION_RE = re.compile(r"^(%s)\b" % "|".join(re.escape(w) for w in SECTION_WORDS), re.IGNORECASE)
PARAGRAPH_TAGS = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6"}


def get_doc_url() -> str:
    config = data_store.load_json(CONFIG_PATH, default={}) or {}
    return config.get("doc_url") or DEFAULT_DOC_URL


def set_doc_url(url: str) -> None:
    data_store.save_json(CONFIG_PATH, {"doc_url": url.strip()})


def fetch_doc_html(doc_url: str) -> str:
    doc_id = setlist.extract_doc_id(doc_url)
    return setlist.fetch_doc_export(doc_id, "html").decode("utf-8", errors="replace")


# ── Reading the HTML export ────────────────────────────────────────────

def _css_rules(css: str) -> dict[str, dict[str, str]]:
    """{".c4": {...}, "h2": {...}} from the export's <style> block."""
    rules: dict[str, dict[str, str]] = {}
    for selector, body in re.findall(r"([^{}]+)\{([^}]*)\}", css):
        props = {}
        for decl in body.split(";"):
            name, _, value = decl.partition(":")
            if value:
                props[name.strip().lower()] = value.strip().lower()
        for sel in selector.split(","):
            sel = sel.strip()
            if re.fullmatch(r"\.[\w-]+|h[1-6]|p|li", sel):
                rules.setdefault(sel, {}).update(props)
    return rules


class _Reader(HTMLParser):
    """The doc's paragraphs, each {"tag", "runs": [(text, style)]} where
    style is the merged CSS of the paragraph's tag and the text's classes.
    A <br> inside a paragraph is kept as a "\\n" run."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rules: dict[str, dict[str, str]] = {}
        self.paragraphs: list[dict] = []
        self._para = None
        self._spans: list[dict] = []
        self._in_style = False
        self._css = ""

    def _class_style(self, attrs) -> dict:
        style = {}
        for cls in (dict(attrs).get("class") or "").split():
            style.update(self.rules.get("." + cls, {}))
        return style

    def handle_starttag(self, tag, attrs):
        if tag == "style":
            self._in_style = True
        elif tag in PARAGRAPH_TAGS:
            base = dict(self.rules.get(tag, {}))
            base.update(self._class_style(attrs))
            self._para = {"tag": tag, "style": base, "runs": []}
            self.paragraphs.append(self._para)
            self._spans = []
        elif tag == "span" and self._para is not None:
            self._spans.append(self._class_style(attrs))
        elif tag == "br" and self._para is not None:
            self._para["runs"].append(("\n", {}))

    def handle_endtag(self, tag):
        if tag == "style":
            self._in_style = False
            self.rules = _css_rules(self._css)
        elif tag in PARAGRAPH_TAGS:
            self._para = None
        elif tag == "span" and self._spans:
            self._spans.pop()

    def handle_data(self, data):
        if self._in_style:
            self._css += data
        elif self._para is not None and data:
            style = dict(self._para["style"])
            for span in self._spans:
                style.update(span)
            self._para["runs"].append((data, style))


def _pt(value: str | None) -> float:
    m = re.match(r"([\d.]+)pt", value or "")
    return float(m.group(1)) if m else 0.0


def _text_color(style: dict) -> str | None:
    """'red' or 'blue' for text coloured clearly red or blue, else None."""
    m = re.fullmatch(r"#([0-9a-f]{6})", style.get("color", ""))
    if not m:
        return None
    r, g, b = (int(m.group(1)[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    if sat < 0.4 or light < 0.15 or light > 0.9:
        return None
    hue *= 360
    if hue <= 20 or hue >= 340:
        return "red"
    if 200 <= hue <= 260:
        return "blue"
    return None


# ── Headings: title and key ─────────────────────────────────────────────

def _read_key(token: str) -> str:
    """A key as written in a heading ("Bbm", "fm", "Hm" -- H is B) in
    chords.KEYS spelling, or "" when it isn't one."""
    token = token.strip()
    if not token:
        return ""
    token = token[0].upper() + token[1:]
    if token[0] == "H":
        token = "B" + token[1:]
    try:
        return chords.clean_key(token)
    except ValueError:
        return ""


NOTE_RE = re.compile(r"\s*[-–]?\s*\b(signe\s+)?tjek\s*$", re.IGNORECASE)


def split_heading(heading: str) -> tuple[str, str]:
    """(title, key) from a song heading such as "Treasure (Bbm)", "On a
    long and lonely night F", "Where is my husband -Bb" or "Pool - fm".
    Notes after the title ("(1 op)", "- original", "-signe tjek") are
    dropped."""
    title, key = " ".join(heading.split()), ""
    for _ in range(3):
        m = re.fullmatch(r"(.+?)\s*\(([^()]*)\)", title)
        if m:
            key = key or _read_key(m.group(2))
            title = m.group(1)
            continue
        m = re.fullmatch(r"(.+?)\s*[-–]\s*([^-–]+)", title)
        if m and len(m.group(2)) <= 25:
            key = key or _read_key(m.group(2))
            title = m.group(1)
            continue
        m = re.fullmatch(r"(.+\S)\s+(\S+)", title)
        if m and not key and _read_key(m.group(2)) and len(m.group(2)) <= 3:
            key = _read_key(m.group(2))
            title = m.group(1)
            continue
        stripped = NOTE_RE.sub("", title)
        if stripped != title and stripped:
            title = stripped
            continue
        break
    return title.strip(" -–"), key


# ── Songs ───────────────────────────────────────────────────────────────

def _section_text(text: str, bold: bool) -> str | None:
    """The section name when a line is a section heading, else None."""
    stripped = text.strip()
    m = re.fullmatch(r"\[(.+)\]", stripped)
    if m:
        return m.group(1).strip()
    if not stripped or len(stripped) > SECTION_MAX_CHARS:
        return None
    if bold or SECTION_RE.match(stripped):
        return stripped.rstrip(":").strip()
    return None


def _lines(paragraph: dict) -> list[list[tuple[str, dict]]]:
    """A paragraph's runs split at its line breaks."""
    lines: list[list[tuple[str, dict]]] = [[]]
    for text, style in paragraph["runs"]:
        parts = text.split("\n")
        for i, part in enumerate(parts):
            if i:
                lines.append([])
            if part:
                lines[-1].append((part, style))
    return lines


def _block(runs: list[tuple[str, dict]]) -> dict:
    text = "".join(t for t, _ in runs)
    visible = [(t, s) for t, s in runs if t.strip()]
    bold = bool(visible) and all(s.get("font-weight") in ("700", "bold") for _, s in visible)
    section = _section_text(text, bold)
    if section is not None:
        return {"type": "section", "runs": [{"text": section, "hl": None}]}
    out: list[dict] = []
    for t, s in runs:
        t = t.replace("\u00a0", " ")
        hl = _text_color(s) if t.strip() else (out[-1]["hl"] if out else None)
        if out and out[-1]["hl"] == hl:
            out[-1]["text"] += t
        else:
            out.append({"text": t, "hl": hl})
    # Trim the line's ends, dropping runs left empty.
    if out:
        out[0]["text"] = out[0]["text"].lstrip()
        out[-1]["text"] = out[-1]["text"].rstrip()
    return {"type": "line", "runs": [r for r in out if r["text"]]}


def _tidy(blocks: list[dict]) -> list[dict]:
    """One blank line at most in a row, none at the ends, and none right
    before a section (sections have space above them already)."""
    tidy: list[dict] = []
    for block in blocks:
        blank = block["type"] == "line" and not block["runs"]
        if blank and (not tidy or (tidy[-1]["type"] == "line" and not tidy[-1]["runs"])):
            continue
        if block["type"] == "section" and tidy and tidy[-1]["type"] == "line" and not tidy[-1]["runs"]:
            tidy.pop()
        tidy.append(block)
    while tidy and tidy[-1]["type"] == "line" and not tidy[-1]["runs"]:
        tidy.pop()
    return tidy


def parse(html: str) -> list[dict]:
    """The doc's songs in order: [{heading, title, key, blocks}]."""
    reader = _Reader()
    reader.feed(html)
    songs: list[dict] = []
    for paragraph in reader.paragraphs:
        text = "".join(t for t, _ in paragraph["runs"]).replace("\u00a0", " ").strip()
        sizes = [_pt(s.get("font-size")) for t, s in paragraph["runs"] if t.strip()]
        if paragraph["tag"] in ("h1", "h2") and text and max(sizes, default=0) >= SONG_HEADING_MIN_PT:
            heading = " ".join(text.split())
            title, key = split_heading(heading)
            songs.append({"heading": heading, "title": title or heading, "key": key, "blocks": []})
            continue
        if songs:
            songs[-1]["blocks"].extend(_block(line) for line in _lines(paragraph))
    for song in songs:
        song["blocks"] = _tidy(song["blocks"])
    return songs


# ── Matching songs ──────────────────────────────────────────────────────

def _norm(title) -> str:
    title = str(title or "").casefold().replace("’", "'")
    title = re.sub(r"[^\w\s]", "", title)
    return " ".join(title.split())


NUMBER_WORDS = {
    "1": "en", "2": "to", "3": "tre", "4": "fire", "5": "fem", "6": "seks",
    "7": "syv", "8": "otte", "9": "ni", "10": "ti", "11": "elleve", "12": "tolv",
}


def _spelled(normed: str) -> str:
    """Numbers written out, so "lidt i 5" and "lidt i fem" compare equal."""
    return " ".join(NUMBER_WORDS.get(word, word) for word in normed.split())


def match(title: str, candidates: list[dict]) -> dict | None:
    """The one candidate ({"title", ...}) the doc's `title` most likely
    is: the same title ignoring case and punctuation; then the same without
    spaces; then a title containing the other; then a close spelling. None
    when nothing fits or it's ambiguous."""
    n = _norm(title)
    if not n:
        return None
    normed = [(_norm(c["title"]), c) for c in candidates]

    def only(found):
        return found[0] if len(found) == 1 else None

    for test in (
        lambda c: c == n,
        lambda c: c.replace(" ", "") == n.replace(" ", ""),
        lambda c: _spelled(c) == _spelled(n),
        lambda c: len(n) >= 4 and len(c) >= 4 and (n in c or c in n),
    ):
        found = [c for t, c in normed if test(t)]
        if found:
            return only(found)
    scored = sorted(
        ((difflib.SequenceMatcher(None, n, t).ratio(), c) for t, c in normed),
        key=lambda pair: pair[0], reverse=True,
    )
    if scored and scored[0][0] >= 0.85 and (len(scored) == 1 or scored[1][0] < scored[0][0] - 0.05):
        return scored[0][1]
    return None


def already_imported(title: str, existing: list[dict]) -> dict | None:
    """Existing lyrics with this title (ignoring case and punctuation)."""
    n = _norm(title)
    return next((doc for doc in existing if _norm(doc["title"]) == n), None)


def suggest(songs: list[dict], repertoire: list[dict], new_songs: list[dict], existing: list[dict]) -> None:
    """Adds each song's likely match ("repertoire_id" or "new_song") and,
    when lyrics with its title exist already, "existing" (their title)."""
    for song in songs:
        found_doc = already_imported(song["title"], existing)
        song["existing"] = found_doc["title"] if found_doc else None
        found = match(song["title"], repertoire)
        song["repertoire_id"] = found["id"] if found else None
        new = None if found else match(song["title"], new_songs)
        song["new_song"] = new["title"] if new else None

"""Master songbook: sync a view-only Google Doc down as a PDF and map each
song title (found by its larger font) -> its page numbers, plus manual title
connections for when a song is titled differently between the setlist tool
and the doc.

Uses the doc's public export endpoint (docs.google.com/.../export?format=...)
rather than the Drive API, so no OAuth/service-account credentials are
needed -- this only works as long as the doc's sharing settings allow
viewers to download/copy/print, which is also a requirement for the Drive
API approach.
"""

import re
from datetime import datetime, timezone
from io import BytesIO

import requests
from pypdf import PdfReader

import data_store

DOC_ID_RE = re.compile(r"/d/([a-zA-Z0-9_-]+)")
EXPORT_URL = "https://docs.google.com/document/d/{doc_id}/export?format=pdf"

CONFIG_PATH = "setlist/config.json"
SONGBOOK_PATH = "setlist/songbook.json"
MASTER_PDF_RELATIVE = "setlist/master.pdf"
ALIASES_PATH = "setlist/aliases.json"


class SyncError(Exception):
    """Raised when the master doc can't be fetched or parsed."""


def extract_doc_id(url_or_id: str) -> str:
    url_or_id = url_or_id.strip()
    match = DOC_ID_RE.search(url_or_id)
    if match:
        return match.group(1)
    if "/" in url_or_id or "." in url_or_id:
        raise SyncError("Couldn't find a document ID in that link.")
    return url_or_id


def get_config() -> dict | None:
    return data_store.load_json(CONFIG_PATH)


def get_master_songbook_url() -> str | None:
    config = get_config()
    return config["doc_url"] if config else None


def set_master_songbook_url(url: str) -> None:
    """Store just the link, without fetching/syncing the doc's pages."""
    url = url.strip()
    if not url:
        raise ValueError("Link can't be empty.")
    data_store.save_json(CONFIG_PATH, {"doc_id": extract_doc_id(url), "doc_url": url})
    data_store.commit_and_push("Update master songbook link")


def get_songbook() -> dict | None:
    return data_store.load_json(SONGBOOK_PATH)


def get_aliases() -> dict[str, str]:
    """Manual {setlist_title: doc_title} connections, for when a song is
    titled differently between the setlist tool and the master doc."""
    return data_store.load_json(ALIASES_PATH, default={})


def set_alias(setlist_title: str, doc_title: str) -> None:
    setlist_title, doc_title = setlist_title.strip(), doc_title.strip()
    if not setlist_title or not doc_title:
        raise ValueError("Both a setlist title and a doc title are required.")
    aliases = get_aliases()
    aliases[setlist_title] = doc_title
    data_store.save_json(ALIASES_PATH, aliases)
    data_store.commit_and_push(f"Connect '{setlist_title}' -> '{doc_title}'")


def get_master_pdf_path():
    return data_store.DATA_DIR / MASTER_PDF_RELATIVE


def _fetch_doc_pdf(doc_id: str) -> bytes:
    try:
        resp = requests.get(EXPORT_URL.format(doc_id=doc_id), timeout=30)
    except requests.RequestException as exc:
        raise SyncError(f"Couldn't reach Google Docs: {exc}") from exc

    if resp.status_code == 403:
        raise SyncError(
            "Google Docs refused the export (403). Make sure the doc's "
            "sharing settings allow viewers to download/copy/print."
        )
    if resp.status_code != 200 or not resp.content.startswith(b"%PDF"):
        raise SyncError(
            f"Export failed (status {resp.status_code}). Check the link is "
            "correct and set to 'Anyone with the link can view'."
        )
    return resp.content


# A song title is any line set noticeably larger than the doc's lyrics
# (the doc's most common font size, by characters). Titles can sit anywhere
# -- partway down a page or at the top of the right-hand column -- so every
# page is scanned in reading order (left column top to bottom, then the
# right column), and a song runs from its title's page to the page the next
# title is on.
TITLE_SIZE_RATIO = 1.2


def _page_lines(page) -> list[dict]:
    """The page's text as lines in reading order, each {"y", "right",
    "size", "text"}: "right" is whether it's in the right-hand column, and
    "size" is its largest font size, in points as printed."""
    runs: list[tuple[float, float, float, str]] = []

    def visit(text, cm, tm, font_dict, font_size):
        # Google Docs' PDFs draw each word as its own piece; the spaces come
        # as separate pieces with unusable positions, so they're skipped and
        # a line's words are joined with spaces instead.
        if not text.strip():
            return
        # Text-space -> page-space: the text matrix, then the current
        # transformation matrix. The point size printed is the font size
        # scaled by that combined matrix.
        a, b, c, d, e, f = tm
        A, B, C, D, E, F = cm
        x = e * A + f * C + E
        y = e * B + f * D + F
        scale = abs((a * A + b * C) * (c * B + d * D) - (a * B + b * D) * (c * A + d * C)) ** 0.5
        runs.append((x, y, round(font_size * scale, 1), text))

    page.extract_text(visitor_text=visit)

    mid_x = float(page.mediabox.width) / 2
    lines: dict[tuple[bool, float], list[tuple[float, float, str]]] = {}
    for x, y, size, text in runs:
        lines.setdefault((x >= mid_x, round(y)), []).append((x, size, text))

    ordered = []
    for (right, y), parts in sorted(lines.items(), key=lambda kv: (kv[0][0], -kv[0][1])):
        parts.sort(key=lambda part: part[0])
        text = " ".join(" ".join(t for _, _, t in parts).split())
        ordered.append({"y": y, "right": right, "size": max(s for _, s, _ in parts), "text": text})
    return ordered


def _body_size(pages_lines: list[list[dict]]) -> float:
    chars: dict[float, int] = {}
    for lines in pages_lines:
        for line in lines:
            chars[line["size"]] = chars.get(line["size"], 0) + len(line["text"])
    return max(chars, key=chars.get) if chars else 0.0


def _page_titles(lines: list[dict], min_size: float) -> list[str]:
    """Title lines on one page, in reading order. A title that wraps onto a
    second line (the next line in the same column, also title-sized) is
    joined back into one."""
    titles: list[str] = []
    prev = None
    for line in lines:
        is_title = line["size"] >= min_size
        if (
            is_title and prev is not None and prev["size"] >= min_size
            and prev["right"] == line["right"]
            and prev["y"] - line["y"] <= 1.8 * line["size"]
        ):
            titles[-1] = f"{titles[-1]} {line['text']}"
        elif is_title:
            titles.append(line["text"])
        prev = line
    return titles


def _group_pages_into_songs(reader: PdfReader) -> list[dict]:
    pages_lines = [_page_lines(page) for page in reader.pages]
    min_size = _body_size(pages_lines) * TITLE_SIZE_RATIO

    songs: list[dict] = []
    seen: dict[str, int] = {}
    for i, lines in enumerate(pages_lines):
        if not lines:
            continue  # blank page
        titles = _page_titles(lines, min_size)
        # The page's text before its first title belongs to the song
        # already running, if any.
        starts_with_title = lines[0]["size"] >= min_size
        if songs and not starts_with_title:
            songs[-1]["pages"].append(i)
        for title in titles:
            if title in seen:
                seen[title] += 1
                title = f"{title} ({seen[title]})"
            else:
                seen[title] = 1
            songs.append({"title": title, "pages": [i]})
    return songs


def sync(doc_url_or_id: str) -> dict:
    """Fetch the master doc, rebuild the song -> pages mapping, persist both."""
    doc_id = extract_doc_id(doc_url_or_id)
    pdf_bytes = _fetch_doc_pdf(doc_id)
    songs = _group_pages_into_songs(PdfReader(BytesIO(pdf_bytes)))

    master_path = get_master_pdf_path()
    master_path.parent.mkdir(parents=True, exist_ok=True)
    master_path.write_bytes(pdf_bytes)

    songbook = {
        "synced_at": datetime.now(timezone.utc).isoformat(),
        "songs": songs,
    }
    data_store.save_json(CONFIG_PATH, {"doc_id": doc_id, "doc_url": doc_url_or_id.strip()})
    data_store.save_json(SONGBOOK_PATH, songbook)
    data_store.commit_and_push(f"Sync setlist songbook ({len(songs)} songs)")
    return songbook

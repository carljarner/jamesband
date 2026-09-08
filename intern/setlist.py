"""Master songbook: sync a view-only Google Doc (one song per page) down as
a PDF and map song title -> page number, plus manual title connections for
when a song is titled differently between the setlist tool and the doc.

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


# A page's first line is treated as a continuation of the previous song
# (rather than a new song title) if it looks like a section marker, e.g.
# "[Vers 1]" or "[Omkvæd: Søs Fenger]" -- songs that run long wrap onto a
# second page starting mid-section, with no title line of their own.
SECTION_MARKER_RE = re.compile(r"^\[.*\]?\s*$|^\[")


def _page_first_line(page) -> str:
    # extract_text()'s default mode drops line breaks on this doc's layout
    # (title + lyrics all come back as one run); layout mode preserves them,
    # using runs of spaces to represent gaps between side-by-side columns --
    # so a two-column page's first line has a second column's text tacked on
    # after the title, separated by a wide gap. Only the first column matters.
    text = page.extract_text(extraction_mode="layout") or ""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    return re.split(r"\s{2,}", lines[0])[0].strip()


def _group_pages_into_songs(reader: PdfReader) -> list[dict]:
    songs: list[dict] = []
    seen: dict[str, int] = {}
    for i, page in enumerate(reader.pages):
        first_line = _page_first_line(page)
        is_continuation = bool(songs) and (
            not first_line or SECTION_MARKER_RE.match(first_line)
        )
        if is_continuation:
            songs[-1]["pages"].append(i)
            continue

        title = first_line or f"Page {i + 1}"
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

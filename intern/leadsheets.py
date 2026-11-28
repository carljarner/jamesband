"""Browser-based lead sheet builder: each song's chart is a single A4 page
of freely-positioned elements (title boxes, bar rows, text fields, repeat
marks, arrows, rhythm notation) rather than a scanned image.

Unlike repertoire.py/setlists.py (one array file for the whole collection),
each sheet is its own file under LEADSHEETS_DIR, named "<id>.json" -- sheets
are large and edited one at a time, so this keeps diffs/commits scoped to
the song that actually changed instead of rewriting every sheet each save.

A sheet can be connected to one repertoire song, and a song to at most one
sheet: "repertoire_id", "new_song" and "link_auto" work as described in
song_links.py.

Sheets are made and edited on leadsheets.dk only; here they're read-only
copies (see leadsheets_remote.py), brought up to date by refresh_sheets().
"source_id" is the leadsheets.dk sheet a copy came from, and
"source_updated_at" that sheet's updated_at when it was copied. Sheets from
before the import have no source_id, but they were the seed of
leadsheets.dk under the same ids, so their own id stands in for it
(source_of).
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import chords
import data_store
import song_links

LEADSHEETS_DIR = "leadsheets"


def _dir() -> Path:
    return data_store.DATA_DIR / LEADSHEETS_DIR


def _path(leadsheet_id: str) -> Path:
    return _dir() / f"{leadsheet_id}.json"


def _existing_ids() -> set[str]:
    if not _dir().exists():
        return set()
    return {p.stem for p in _dir().glob("*.json")}


def list_leadsheets() -> list[dict]:
    if not _dir().exists():
        return []
    sheets = [json.loads(p.read_text()) for p in _dir().glob("*.json")]
    return sorted(sheets, key=lambda sheet: sheet["title"].casefold())


def get_leadsheet(leadsheet_id: str) -> dict:
    path = _path(leadsheet_id)
    if not path.exists():
        raise KeyError(leadsheet_id)
    return json.loads(path.read_text())


def _save(sheet: dict) -> None:
    path = _path(sheet["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sheet, indent=2))


def _unique_id(title: str, existing_ids: set[str]) -> str:
    base = chords.slugify(title)
    if base not in existing_ids:
        return base
    n = 2
    while f"{base}-{n}" in existing_ids:
        n += 1
    return f"{base}-{n}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_doc(leadsheet_id: str, doc: dict) -> dict:
    """The sheet as stored. `repertoire_id` is carried over only when the
    doc has one (see the module docstring for why absent differs from None)."""
    title = str(doc.get("title") or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    elements = doc.get("elements", [])
    if not isinstance(elements, list):
        raise ValueError("Malformed lead sheet document.")
    cleaned = {
        "id": leadsheet_id,
        "title": title,
        "artist": str(doc.get("artist") or "").strip(),
        "key": str(doc.get("key") or "").strip(),
        "updated_at": _now(),
        "elements": elements,
    }
    if "repertoire_id" in doc:
        cleaned["repertoire_id"] = str(doc["repertoire_id"] or "").strip() or None
    for field in LINK_FIELDS:
        url = _clean_url(doc.get(field))
        if url:
            cleaned[field] = url
    return cleaned


# The practice links shown in the sheet's Practice box.
LINK_FIELDS = ("lyrics_url", "youtube_url", "spotify_url")


def _clean_url(value) -> str:
    """A link as stored: trimmed, with https:// added when it has no scheme."""
    url = str(value or "").strip()
    if url and "://" not in url:
        url = "https://" + url
    return url


# Kept across a refresh: where the copy came from and what it's connected to.
SOURCE_FIELDS = ("source_id", "imported_at", "source_updated_at")
LINK_KEYS = ("repertoire_id", "new_song", "link_auto")
# leadsheets.dk ids are slugs; they also become file names here.
SOURCE_ID_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")


def source_of(sheet: dict) -> str:
    """The leadsheets.dk id this sheet was imported from."""
    return sheet.get("source_id") or sheet["id"]


def imported_source_ids() -> set[str]:
    return {source_of(s) for s in list_leadsheets()}


def _from_source(leadsheet_id: str, doc: dict) -> dict:
    """A leadsheets.dk doc as stored here, without any connection of its own."""
    doc = {k: v for k, v in doc.items() if k not in LINK_KEYS}
    sheet = _clean_doc(leadsheet_id, doc)
    sheet["source_updated_at"] = str(doc.get("updated_at") or "")
    sheet["imported_at"] = _now()
    return sheet


def import_sheet(doc: dict) -> dict:
    """A copy of a leadsheets.dk sheet, under the same id when it's free.
    It has no repertoire_id yet, so auto_link() may connect it by title."""
    source_id = str(doc.get("id") or "").strip()
    if not SOURCE_ID_RE.fullmatch(source_id):
        raise ValueError("Malformed lead sheet from leadsheets.dk.")
    existing = _existing_ids()
    leadsheet_id = source_id if source_id not in existing else _unique_id(doc.get("title") or source_id, existing)
    sheet = _from_source(leadsheet_id, doc)
    sheet["source_id"] = source_id
    _save(sheet)
    return sheet


def reset_from_source(leadsheet_id: str, doc: dict) -> dict:
    """Replace a sheet's content with its current leadsheets.dk version,
    keeping what it's connected to."""
    stored = get_leadsheet(leadsheet_id)
    sheet = _from_source(leadsheet_id, doc)
    sheet["source_id"] = source_of(stored)
    for key in LINK_KEYS:
        if key in stored:
            sheet[key] = stored[key]
    _save(sheet)
    return sheet


def stale_sheets(remote: list[dict]) -> tuple[list[dict], list[dict]]:
    """(sheets whose leadsheets.dk version changed since they were copied,
    sheets no longer on leadsheets.dk), given leadsheets_remote.list_sheets()."""
    remote_updated = {s.get("id"): str(s.get("updated_at") or "") for s in remote if s.get("id")}
    stale, gone = [], []
    for sheet in list_leadsheets():
        source = source_of(sheet)
        if source not in remote_updated:
            gone.append(sheet)
        elif not sheet.get("source_updated_at") or sheet["source_updated_at"] != remote_updated[source]:
            stale.append(sheet)
    return stale, gone


# ── Connecting sheets to songs (see song_links.py) ─────────────────────

upcoming_new_songs = song_links.upcoming_new_songs


def set_link(leadsheet_id: str, repertoire_id: str | None = None, new_song: str | None = None) -> dict:
    """Connect a sheet by hand to a repertoire song, or to a new song (by
    title), or to nothing when both are empty."""
    sheet = get_leadsheet(leadsheet_id)
    song_links.apply_link(sheet, list_leadsheets(), repertoire_id, new_song, "lead sheet")
    _save(sheet)
    return sheet


def delete_leadsheet(leadsheet_id: str) -> None:
    path = _path(leadsheet_id)
    if not path.exists():
        raise KeyError(leadsheet_id)
    path.unlink()


def new_song_links() -> dict[str, dict]:
    """{folded new-song title: its sheet} for every sheet connected to one."""
    return song_links.new_song_links(list_leadsheets())


def links() -> dict[str, dict]:
    """{repertoire song id: its sheet} for every connected song."""
    return song_links.links(list_leadsheets())


def auto_link() -> None:
    """Connect sheets whose connection was never decided by title (see
    song_links.auto_link)."""
    song_links.auto_link(list_leadsheets(), _save)

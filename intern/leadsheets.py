"""Browser-based lead sheet builder: each song's chart is a single A4 page
of freely-positioned elements (title boxes, bar rows, text fields, repeat
marks, arrows, rhythm notation) rather than a scanned image.

Unlike repertoire.py/setlists.py (one array file for the whole collection),
each sheet is its own file under LEADSHEETS_DIR, named "<id>.json" -- sheets
are large and edited one at a time, so this keeps diffs/commits scoped to
the song that actually changed instead of rewriting every sheet each save.

A sheet can be connected to one repertoire song ("repertoire_id"), and a
song to at most one sheet. The key's three states: absent -- never decided,
so auto_link() may connect it by title; None -- explicitly not connected;
an id -- connected.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import chords
import data_store
import repertoire

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


def add_leadsheet(title: str, artist: str = "") -> dict:
    title = str(title or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    leadsheet_id = _unique_id(title, _existing_ids())
    sheet = _clean_doc(leadsheet_id, {"title": title, "artist": artist, "elements": []})
    _save(sheet)
    data_store.commit_and_push(f"Add lead sheet '{sheet['title']}'")
    return sheet


def update_leadsheet(leadsheet_id: str, doc: dict) -> dict:
    if not _path(leadsheet_id).exists():
        raise KeyError(leadsheet_id)
    cleaned = _clean_doc(leadsheet_id, doc)
    song_id = cleaned.get("repertoire_id")
    if song_id:
        other = sheet_for_repertoire_id(song_id)
        if other and other["id"] != leadsheet_id:
            raise ValueError(f"That song is already connected to the lead sheet '{other['title']}'.")
    _save(cleaned)
    data_store.commit_and_push(f"Update lead sheet '{cleaned['title']}'")
    return cleaned


def delete_leadsheet(leadsheet_id: str) -> None:
    path = _path(leadsheet_id)
    if not path.exists():
        raise KeyError(leadsheet_id)
    path.unlink()
    data_store.commit_and_push("Remove lead sheet")


# ── Connecting sheets to repertoire songs ──────────────────────────────

def sheet_for_repertoire_id(song_id: str) -> dict | None:
    return next((s for s in list_leadsheets() if s.get("repertoire_id") == song_id), None)


def links() -> dict[str, dict]:
    """{repertoire song id: its sheet} for every connected song."""
    return {s["repertoire_id"]: s for s in list_leadsheets() if s.get("repertoire_id")}


def _find_match(title: str, candidates: list[dict], all_titles: list[str]) -> dict | None:
    """The repertoire song a sheet titled `title` should connect to, the way
    the setlist editor auto-connects lyrics (findAutoConnections): an exact
    title (ignoring case) first; else a title containing the other, but only
    when that's unambiguous both ways -- one candidate song, and no other
    unconnected sheet that would match it too."""
    folded = title.casefold()
    exact = [song for song in candidates if song["title"].strip().casefold() == folded]
    if len(exact) == 1:
        return exact[0]

    def contains(a: str, b: str) -> bool:
        a, b = a.casefold(), b.casefold()
        return bool(a and b) and (a in b or b in a)

    loose = [song for song in candidates if contains(song["title"].strip(), title)]
    if len(loose) != 1:
        return None
    rivals = [t for t in all_titles if contains(loose[0]["title"].strip(), t)]
    return loose[0] if len(rivals) == 1 else None


def auto_link() -> None:
    """Connect every sheet whose connection was never decided to the
    repertoire song with the same title, if there is exactly one free one.
    Sheets with no match stay undecided, so a song added later still can."""
    sheets = list_leadsheets()
    undecided = [s for s in sheets if "repertoire_id" not in s]
    if not undecided:
        return
    taken = {s["repertoire_id"] for s in sheets if s.get("repertoire_id")}
    free_songs = [song for song in repertoire.list_songs() if song["id"] not in taken]
    undecided_titles = [s["title"] for s in undecided]
    for sheet in undecided:
        song = _find_match(sheet["title"], free_songs, undecided_titles)
        if song is None:
            continue
        sheet["repertoire_id"] = song["id"]
        free_songs.remove(song)
        _save(sheet)

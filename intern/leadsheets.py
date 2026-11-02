"""Browser-based lead sheet builder: each song's chart is a single A4 page
of freely-positioned elements (title boxes, bar rows, text fields, repeat
marks, arrows, rhythm notation) rather than a scanned image.

Unlike repertoire.py/setlists.py (one array file for the whole collection),
each sheet is its own file under LEADSHEETS_DIR, named "<id>.json" -- sheets
are large and edited one at a time, so this keeps diffs/commits scoped to
the song that actually changed instead of rewriting every sheet each save.

A sheet can be connected to one repertoire song ("repertoire_id"), and a
song to at most one sheet. The key's three states: absent -- never decided,
so auto_link() may connect it by title; None -- not connected to a
repertoire song; an id -- connected. With repertoire_id None, "new_song"
may instead hold the title of a song from an upcoming setlist that isn't in
the repertoire yet (see upcoming_new_songs); once that song joins the
repertoire, auto_link() moves the sheet over to it. "link_auto" marks a
connection made by title matching rather than picked by hand.

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
import repertoire
import setlists

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


# ── Connecting sheets to songs ─────────────────────────────────────────

def _fold(title) -> str:
    return str(title or "").strip().casefold()


def upcoming_new_songs() -> list[dict]:
    """Songs on upcoming setlists that aren't in the repertoire, once per
    title (ignoring case), soonest gig first. A row whose title matches a
    repertoire song counts as that song, even if it was never linked to it.
    Each carries the song fields of its soonest row, so it can be copied
    onto another setlist: [{title, artist, year, key, signe, jonas, duet,
    indstilling, gigs: [{id, date, venue}]}]."""
    upcoming, _ = setlists.split_upcoming_past(setlists.list_setlists())
    known = {_fold(song.get("title")) for song in repertoire.list_songs()}
    by_title: dict[str, dict] = {}
    for gig in upcoming:
        for row in gig.get("songs", []):
            if row.get("type") != "song" or row.get("repertoire_id"):
                continue
            folded = _fold(row.get("title"))
            if not folded or folded in known:
                continue
            entry = by_title.get(folded)
            if entry is None:
                entry = by_title[folded] = {field: row.get(field) for field in repertoire.FIELDS}
                entry["title"] = row["title"].strip()
                entry["artist"] = row.get("artist") or ""
                entry["gigs"] = []
            if not entry["artist"] and row.get("artist"):
                entry["artist"] = row["artist"]
            if not any(g["id"] == gig["id"] for g in entry["gigs"]):
                entry["gigs"].append({"id": gig["id"], "date": gig.get("date", ""), "venue": gig.get("venue", "")})
    return list(by_title.values())


def set_link(leadsheet_id: str, repertoire_id: str | None = None, new_song: str | None = None) -> dict:
    """Connect a sheet by hand to a repertoire song, or to a new song (by
    title), or to nothing when both are empty."""
    sheet = get_leadsheet(leadsheet_id)
    repertoire_id = str(repertoire_id or "").strip() or None
    new_song = str(new_song or "").strip() or None
    if repertoire_id:
        if not any(song["id"] == repertoire_id for song in repertoire.list_songs()):
            raise ValueError("That repertoire song doesn't exist.")
        other = sheet_for_repertoire_id(repertoire_id)
        new_song = None
    elif new_song:
        other = sheet_for_new_song(new_song)
    else:
        other = None
    if other and other["id"] != leadsheet_id:
        raise ValueError(f"That song is already connected to the lead sheet '{other['title']}'.")
    sheet["repertoire_id"] = repertoire_id
    sheet.pop("link_auto", None)
    if new_song:
        sheet["new_song"] = new_song
    else:
        sheet.pop("new_song", None)
    _save(sheet)
    data_store.commit_and_push(f"Connect lead sheet '{sheet['title']}'")
    return sheet


def delete_leadsheet(leadsheet_id: str) -> None:
    path = _path(leadsheet_id)
    if not path.exists():
        raise KeyError(leadsheet_id)
    path.unlink()
    data_store.commit_and_push("Remove lead sheet")


def sheet_for_repertoire_id(song_id: str) -> dict | None:
    return next((s for s in list_leadsheets() if s.get("repertoire_id") == song_id), None)


def sheet_for_new_song(title: str) -> dict | None:
    folded = _fold(title)
    return next((s for s in list_leadsheets() if s.get("new_song") and _fold(s["new_song"]) == folded), None)


def new_song_links() -> dict[str, dict]:
    """{folded new-song title: its sheet} for every sheet connected to one."""
    return {_fold(s["new_song"]): s for s in list_leadsheets() if s.get("new_song")}


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
    """Connect every sheet whose connection was never decided to the song
    with the same title, if there is exactly one free one: a repertoire song
    first, else a new song from an upcoming setlist. A sheet connected to a
    new song moves to the repertoire song once one has that title. Sheets
    with no match stay undecided, so a song added later still can."""
    sheets = list_leadsheets()
    songs = repertoire.list_songs()
    taken = {s["repertoire_id"] for s in sheets if s.get("repertoire_id")}
    free_songs = [song for song in songs if song["id"] not in taken]

    for sheet in sheets:
        if not sheet.get("new_song"):
            continue
        song = next((s for s in free_songs if _fold(s["title"]) == _fold(sheet["new_song"])), None)
        if song is None:
            continue
        sheet["repertoire_id"] = song["id"]
        del sheet["new_song"]
        free_songs.remove(song)
        _save(sheet)

    undecided = [s for s in sheets if "repertoire_id" not in s]
    if not undecided:
        return
    taken_new = {_fold(s["new_song"]) for s in sheets if s.get("new_song")}
    free_new = [song for song in upcoming_new_songs() if _fold(song["title"]) not in taken_new]
    undecided_titles = [s["title"] for s in undecided]
    for sheet in undecided:
        song = _find_match(sheet["title"], free_songs, undecided_titles)
        if song is not None:
            sheet["repertoire_id"] = song["id"]
            free_songs.remove(song)
        else:
            song = _find_match(sheet["title"], free_new, undecided_titles)
            if song is None:
                continue
            sheet["repertoire_id"] = None
            sheet["new_song"] = song["title"]
            free_new.remove(song)
        sheet["link_auto"] = True
        _save(sheet)

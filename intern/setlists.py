"""Feature 5: setlists -- a record of past gigs (date, venue, lineup, notes)
and the songs played, built by picking songs from the repertoire or adding
one-off songs that aren't in it. Song entries are a snapshot at add time
(same shape as a repertoire row, plus which singer's transposition applies
at this gig), not a live join against the repertoire, so editing a
repertoire song later doesn't rewrite gig history.
"""

import uuid
from datetime import date

import data_store
import repertoire

SETLISTS_PATH = "setlists/setlists.json"

FIELDS = ("date", "venue", "lineup", "notes")
SONG_TEXT_FIELDS = ("title", "artist", "year", "key", "signe", "jonas", "duet", "indstilling")
VALID_SINGERS = {"", "signe", "jonas", "duet"}
VALID_SONG_TYPES = {"song", "break"}


def list_setlists() -> list[dict]:
    setlists = data_store.load_json(SETLISTS_PATH, default=[])
    return sorted(setlists, key=lambda s: s["date"], reverse=True)


def split_upcoming_past(setlists: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split into (upcoming, past) using today's date, soonest-first / most-recent-first."""
    today = date.today().isoformat()
    upcoming = sorted((s for s in setlists if s["date"] >= today), key=lambda s: s["date"])
    past = sorted((s for s in setlists if s["date"] < today), key=lambda s: s["date"], reverse=True)
    return upcoming, past


def get_setlist(setlist_id: str) -> dict:
    for setlist in list_setlists():
        if setlist["id"] == setlist_id:
            return setlist
    raise KeyError(setlist_id)


def _save(setlists: list[dict]) -> None:
    data_store.save_json(SETLISTS_PATH, setlists)


def _clean_songs(songs) -> list[dict]:
    if not isinstance(songs, list):
        raise ValueError("songs must be a list")
    cleaned = []
    for song in songs:
        if not isinstance(song, dict):
            raise ValueError("each song must be an object")
        song_type = str(song.get("type") or "song").strip().lower()
        if song_type not in VALID_SONG_TYPES:
            raise ValueError(f"invalid song type '{song_type}'")
        if song_type == "break":
            # A pause marker between sets -- no song fields to keep.
            cleaned.append({"type": "break"})
            continue
        entry = {field: str(song.get(field) or "").strip() for field in SONG_TEXT_FIELDS}
        singer = str(song.get("singer") or "").strip().lower()
        if singer not in VALID_SINGERS:
            raise ValueError(f"invalid singer '{singer}'")
        entry["singer"] = singer
        entry["repertoire_id"] = song.get("repertoire_id") or None
        entry["type"] = "song"
        if entry["title"]:
            cleaned.append(entry)
    return cleaned


def add_setlist(fields: dict, songs: list) -> dict:
    setlist = {"id": uuid.uuid4().hex[:8]}
    setlist.update({field: (fields.get(field) or "").strip() for field in FIELDS})
    setlist["songs"] = _clean_songs(songs)
    setlists = list_setlists()
    setlists.append(setlist)
    _save(setlists)
    data_store.commit_and_push(f"Add setlist '{setlist['venue'] or setlist['date']}'")
    return setlist


def update_setlist(setlist_id: str, fields: dict, songs: list) -> dict:
    setlists = list_setlists()
    for setlist in setlists:
        if setlist["id"] == setlist_id:
            for field in FIELDS:
                if field in fields:
                    setlist[field] = str(fields[field] or "").strip()
            if songs is not None:
                setlist["songs"] = _clean_songs(songs)
            _save(setlists)
            data_store.commit_and_push(f"Update setlist '{setlist['venue'] or setlist['date']}'")
            return setlist
    raise KeyError(setlist_id)


def delete_setlist(setlist_id: str) -> None:
    setlists = list_setlists()
    remaining = [s for s in setlists if s["id"] != setlist_id]
    if len(remaining) == len(setlists):
        raise KeyError(setlist_id)
    _save(remaining)
    data_store.commit_and_push("Remove setlist")


def add_to_repertoire(setlist_id: str) -> dict:
    setlists_all = list_setlists()
    target = next((s for s in setlists_all if s["id"] == setlist_id), None)
    if target is None:
        raise KeyError(setlist_id)

    created = repertoire.merge_from_setlist(target["songs"])
    if created:
        for row_index, new_id in created:
            target["songs"][row_index]["repertoire_id"] = new_id
        _save(setlists_all)
        data_store.commit_and_push(
            f"Link new repertoire songs to setlist '{target['venue'] or target['date']}'"
        )
    return {"song_count": len(target["songs"]), "created_count": len(created)}

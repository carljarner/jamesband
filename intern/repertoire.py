"""Feature 4: repertoire -- the band's known-song list, editable like a
spreadsheet. Signe/Jonas hold each singer's transposition for a song once
they've actually sung it; left blank until then.
"""

import json
import time
import uuid

import requests

import data_store

REPERTOIRE_PATH = "repertoire/songs.json"
PUBLIC_REPERTOIRE_PATH = "repertoire.json"  # public/repertoire.json, fetched by the public site

FIELDS = ("title", "artist", "year", "key", "signe", "jonas", "duet", "indstilling")


def list_songs() -> list[dict]:
    songs = data_store.load_json(REPERTOIRE_PATH, default=[])
    return sorted(songs, key=lambda song: song["title"].casefold())


def _fetch_cover(title: str, artist: str) -> str:
    """Best-effort album art lookup via the iTunes Search API (no key
    needed). Returns '' on no match or any network hiccup -- a bad lookup
    should never block saving a song."""
    if not title:
        return ""
    try:
        resp = requests.get(
            "https://itunes.apple.com/search",
            params={
                "term": f"{title} {artist}".strip(),
                "country": "DK",
                "media": "music",
                "entity": "song",
                "limit": 1,
            },
            timeout=5,
        )
        resp.raise_for_status()
        results = resp.json().get("results") or []
        artwork = results[0].get("artworkUrl100", "") if results else ""
        return artwork.replace("100x100bb", "600x600bb")
    except Exception:
        return ""


def export_public() -> None:
    """Regenerate public/repertoire.json -- only the public-safe fields
    (title/artist/cover), the rest are internal transposition notes."""
    public_songs = [
        {"title": song["title"], "artist": song["artist"], "cover": song.get("cover", "")}
        for song in list_songs()
    ]
    path = data_store.REPO_DIR / "public" / PUBLIC_REPERTOIRE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(public_songs, indent=2))


def _save(songs: list[dict]) -> None:
    data_store.save_json(REPERTOIRE_PATH, songs)
    export_public()


def add_song(fields: dict) -> dict:
    song = {"id": uuid.uuid4().hex[:8]}
    song.update({field: (fields.get(field) or "").strip() for field in FIELDS})
    song["cover"] = _fetch_cover(song["title"], song["artist"])
    songs = list_songs()
    songs.append(song)
    _save(songs)
    data_store.commit_and_push(f"Add repertoire song '{song['title']}'")
    return song


def update_song(song_id: str, fields: dict) -> dict:
    songs = list_songs()
    for song in songs:
        if song["id"] == song_id:
            retitled = False
            for field in FIELDS:
                if field in fields:
                    new_value = str(fields[field] or "").strip()
                    if field in ("title", "artist") and new_value != song.get(field):
                        retitled = True
                    song[field] = new_value
            if "cover" in fields:
                # An explicit cover (e.g. a manual fix in the UI) always wins
                # over auto-lookup, even if the title/artist also changed.
                song["cover"] = str(fields["cover"] or "").strip()
            elif retitled or not song.get("cover"):
                song["cover"] = _fetch_cover(song["title"], song["artist"])
            _save(songs)
            data_store.commit_and_push(f"Update repertoire song '{song['title']}'")
            return song
    raise KeyError(song_id)


def delete_song(song_id: str) -> None:
    songs = list_songs()
    remaining = [s for s in songs if s["id"] != song_id]
    if len(remaining) == len(songs):
        raise KeyError(song_id)
    _save(remaining)
    data_store.commit_and_push("Remove repertoire song")


def merge_from_setlist(setlist_songs: list[dict]) -> list[tuple[int, str]]:
    """Overwrite/create repertoire entries from a saved setlist's song rows.
    One _save + one commit_and_push total. Returns (row_index, new_song_id)
    for rows that became brand-new entries, so the caller can link them back.
    """
    if not setlist_songs:
        return []

    songs = list_songs()
    by_id = {song["id"]: song for song in songs}
    created: list[tuple[int, str]] = []

    for idx, row in enumerate(setlist_songs):
        if not str(row.get("title") or "").strip():
            continue
        target = by_id.get(row.get("repertoire_id"))
        if target is None:
            target = {"id": uuid.uuid4().hex[:8]}
            songs.append(target)
            by_id[target["id"]] = target
            created.append((idx, target["id"]))
        prev_title, prev_artist = target.get("title"), target.get("artist")
        for field in FIELDS:
            target[field] = str(row.get(field) or "").strip()
        if target["title"] != prev_title or target["artist"] != prev_artist or not target.get("cover"):
            target["cover"] = _fetch_cover(target["title"], target["artist"])

    _save(songs)
    data_store.commit_and_push(f"Sync repertoire from setlist ({len(setlist_songs)} songs)")
    return created


def backfill_covers() -> int:
    """Maintenance helper: fetch cover art for any song that doesn't have
    one yet (e.g. songs added before cover lookup existed). Returns how
    many songs were updated."""
    songs = list_songs()
    updated = 0
    for song in songs:
        if not song.get("cover"):
            if updated:
                time.sleep(3)  # iTunes' search endpoint rate-limits at ~20 req/min
            song["cover"] = _fetch_cover(song.get("title", ""), song.get("artist", ""))
            updated += 1
    if updated:
        _save(songs)
        data_store.commit_and_push(f"Backfill repertoire cover art ({updated} songs)")
    return updated

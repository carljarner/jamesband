"""Feature 4: repertoire -- the band's known-song list, editable like a
spreadsheet. Signe/Jonas hold each singer's transposition for a song once
they've actually sung it; left blank until then.
"""

import json
import uuid

import data_store

REPERTOIRE_PATH = "repertoire/songs.json"
PUBLIC_REPERTOIRE_PATH = "repertoire.json"  # public/repertoire.json, fetched by the public site

FIELDS = ("title", "artist", "year", "key", "signe", "jonas", "duet", "indstilling")


def list_songs() -> list[dict]:
    songs = data_store.load_json(REPERTOIRE_PATH, default=[])
    return sorted(songs, key=lambda song: song["title"].casefold())


def export_public() -> None:
    """Regenerate public/repertoire.json -- only the public-safe fields
    (title/artist), the rest are internal transposition notes."""
    public_songs = [
        {"title": song["title"], "artist": song["artist"]} for song in list_songs()
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
    songs = list_songs()
    songs.append(song)
    _save(songs)
    data_store.commit_and_push(f"Add repertoire song '{song['title']}'")
    return song


def update_song(song_id: str, fields: dict) -> dict:
    songs = list_songs()
    for song in songs:
        if song["id"] == song_id:
            for field in FIELDS:
                if field in fields:
                    song[field] = str(fields[field] or "").strip()
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
        for field in FIELDS:
            target[field] = str(row.get(field) or "").strip()

    _save(songs)
    data_store.commit_and_push(f"Sync repertoire from setlist ({len(setlist_songs)} songs)")
    return created

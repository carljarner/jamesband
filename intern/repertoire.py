"""Feature 4: repertoire -- the band's known-song list, editable like a
spreadsheet. Signe/Jonas hold each singer's transposition for a song once
they've actually sung it; left blank until then.
"""

import uuid

import data_store

REPERTOIRE_PATH = "repertoire/songs.json"

FIELDS = ("title", "artist", "year", "key", "signe", "jonas", "duet", "indstilling")


def list_songs() -> list[dict]:
    songs = data_store.load_json(REPERTOIRE_PATH, default=[])
    return sorted(songs, key=lambda song: song["title"].casefold())


def _save(songs: list[dict]) -> None:
    data_store.save_json(REPERTOIRE_PATH, songs)


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

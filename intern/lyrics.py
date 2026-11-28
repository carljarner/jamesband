"""Song lyrics, written in the browser (static/lyrics-editor.js) like the
band's old Google Doc: typed section headings ("Vers 1", "Omkvæd", ...)
and lines of text, parts of which can be highlighted blue or red.

Like leadsheets.py, each song's lyrics are their own file under
LYRICS_DIR, named "<id>.json". A doc is connected to a song through
"repertoire_id" / "new_song" / "link_auto" (see song_links.py).

"blocks" holds the text, top to bottom: [{"type": "section" | "line",
"runs": [{"text": str, "hl": "blue" | "red" | None}]}]. A blank line is a
line with no runs. Only that structure is stored -- never HTML.
"""

import re
from datetime import datetime, timezone
from pathlib import Path

import chords
import data_store
import song_links

LYRICS_DIR = "lyrics"
BLOCK_TYPES = ("section", "line")
HIGHLIGHTS = ("blue", "red")
MAX_BLOCKS = 2000
MAX_TEXT = 2000
ID_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
# Page addresses under /lyrics/ that aren't lyrics.
RESERVED_IDS = {"new", "import"}


def _dir() -> Path:
    return data_store.DATA_DIR / LYRICS_DIR


def _path(lyrics_id: str) -> Path:
    return _dir() / f"{lyrics_id}.json"


def list_lyrics() -> list[dict]:
    if not _dir().exists():
        return []
    docs = [data_store.load_json(f"{LYRICS_DIR}/{p.name}") for p in _dir().glob("*.json")]
    return sorted(docs, key=lambda doc: doc["title"].casefold())


def get_lyrics(lyrics_id: str) -> dict:
    if not ID_RE.fullmatch(lyrics_id) or not _path(lyrics_id).exists():
        raise KeyError(lyrics_id)
    return data_store.load_json(f"{LYRICS_DIR}/{lyrics_id}.json")


def _save(doc: dict) -> None:
    data_store.save_json(f"{LYRICS_DIR}/{doc['id']}.json", doc)


def _unique_id(title: str) -> str:
    existing = {p.stem for p in _dir().glob("*.json")} if _dir().exists() else set()
    try:
        base = chords.slugify(title)
    except chords.ChordError:  # nothing left of a title like "Øø"
        base = "lyrics"
    existing |= RESERVED_IDS
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


def _clean_blocks(blocks) -> list[dict]:
    if not isinstance(blocks, list) or len(blocks) > MAX_BLOCKS:
        raise ValueError("Malformed lyrics.")
    cleaned = []
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") not in BLOCK_TYPES:
            raise ValueError("Malformed lyrics.")
        runs = block.get("runs", [])
        if not isinstance(runs, list):
            raise ValueError("Malformed lyrics.")
        clean_runs = []
        for run in runs:
            if not isinstance(run, dict) or not isinstance(run.get("text"), str):
                raise ValueError("Malformed lyrics.")
            hl = run.get("hl")
            if hl is not None and hl not in HIGHLIGHTS:
                raise ValueError("Malformed lyrics.")
            text = run["text"].replace("\n", " ")[:MAX_TEXT]
            if not text:
                continue
            # Neighbouring runs with the same highlight become one.
            if clean_runs and clean_runs[-1]["hl"] == hl:
                clean_runs[-1]["text"] += text
            else:
                clean_runs.append({"text": text, "hl": hl})
        cleaned.append({"type": block["type"], "runs": clean_runs})
    return cleaned


def _fields(doc: dict) -> dict:
    """The editable fields of a doc as stored."""
    if not isinstance(doc, dict):
        raise ValueError("Malformed lyrics.")
    title = str(doc.get("title") or "").strip()
    if not title:
        raise ValueError("Title can't be empty.")
    return {
        "title": title,
        "artist": str(doc.get("artist") or "").strip(),
        "key": chords.clean_key(doc.get("key")),
        "blocks": _clean_blocks(doc.get("blocks", [])),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def create(doc: dict) -> dict:
    """New lyrics, connected to the song `doc` names ("repertoire_id" or
    "new_song") or to none."""
    fields = _fields(doc)
    lyrics = {"id": _unique_id(fields["title"]), **fields}
    song_links.apply_link(lyrics, list_lyrics(), doc.get("repertoire_id"), doc.get("new_song"), "lyrics")
    _save(lyrics)
    return lyrics


def save(lyrics_id: str, doc: dict) -> dict:
    lyrics = get_lyrics(lyrics_id)
    lyrics.update(_fields(doc))
    _save(lyrics)
    return lyrics


def set_link(lyrics_id: str, repertoire_id: str | None = None, new_song: str | None = None) -> dict:
    lyrics = get_lyrics(lyrics_id)
    song_links.apply_link(lyrics, list_lyrics(), repertoire_id, new_song, "lyrics")
    _save(lyrics)
    return lyrics


def delete(lyrics_id: str) -> None:
    get_lyrics(lyrics_id)
    _path(lyrics_id).unlink()


def links() -> dict[str, dict]:
    return song_links.links(list_lyrics())


def new_song_links() -> dict[str, dict]:
    return song_links.new_song_links(list_lyrics())


def auto_link() -> None:
    song_links.auto_link(list_lyrics(), _save)

"""Browser-based lead sheet builder: each song's chart is a single A4 page
of freely-positioned elements (title boxes, bar rows, text fields, repeat
marks, arrows, rhythm notation) rather than a scanned image.

Unlike repertoire.py/setlists.py (one array file for the whole collection),
each sheet is its own file under LEADSHEETS_DIR, named "<id>.json" -- sheets
are large and edited one at a time, so this keeps diffs/commits scoped to
the song that actually changed instead of rewriting every sheet each save.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import chords
import data_store

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
    title = str(doc.get("title") or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    elements = doc.get("elements", [])
    if not isinstance(elements, list):
        raise ValueError("Malformed lead sheet document.")
    return {
        "id": leadsheet_id,
        "title": title,
        "artist": str(doc.get("artist") or "").strip(),
        "key": str(doc.get("key") or "").strip(),
        "updated_at": _now(),
        "elements": elements,
    }


def add_leadsheet(title: str) -> dict:
    title = str(title or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    leadsheet_id = _unique_id(title, _existing_ids())
    sheet = _clean_doc(leadsheet_id, {"title": title, "elements": []})
    _save(sheet)
    data_store.commit_and_push(f"Add lead sheet '{sheet['title']}'")
    return sheet


def update_leadsheet(leadsheet_id: str, doc: dict) -> dict:
    if not _path(leadsheet_id).exists():
        raise KeyError(leadsheet_id)
    cleaned = _clean_doc(leadsheet_id, doc)
    _save(cleaned)
    data_store.commit_and_push(f"Update lead sheet '{cleaned['title']}'")
    return cleaned


def delete_leadsheet(leadsheet_id: str) -> None:
    path = _path(leadsheet_id)
    if not path.exists():
        raise KeyError(leadsheet_id)
    path.unlink()
    data_store.commit_and_push("Remove lead sheet")


def import_leadsheet(doc: dict) -> dict:
    title = str(doc.get("title") or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    leadsheet_id = _unique_id(title, _existing_ids())
    cleaned = _clean_doc(leadsheet_id, doc)
    _save(cleaned)
    data_store.commit_and_push(f"Import lead sheet '{cleaned['title']}'")
    return cleaned

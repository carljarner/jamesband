"""Browser-based lead sheet builder: each song's chart is a single A4 page
of freely-positioned elements (title boxes, bar rows, text fields, repeat
marks, arrows, rhythm notation) rather than a scanned image. Follows the
same collection-keyed-by-id pattern as repertoire.py/setlists.py.
"""

from datetime import datetime, timezone

import chords
import data_store

LEADSHEETS_PATH = "leadsheets/leadsheets.json"


def list_leadsheets() -> list[dict]:
    sheets = data_store.load_json(LEADSHEETS_PATH, default=[])
    return sorted(sheets, key=lambda sheet: sheet["title"].casefold())


def get_leadsheet(leadsheet_id: str) -> dict:
    for sheet in list_leadsheets():
        if sheet["id"] == leadsheet_id:
            return sheet
    raise KeyError(leadsheet_id)


def _save(sheets: list[dict]) -> None:
    data_store.save_json(LEADSHEETS_PATH, sheets)


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
        "key": str(doc.get("key") or "").strip(),
        "updated_at": _now(),
        "elements": elements,
    }


def add_leadsheet(title: str) -> dict:
    title = str(title or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    sheets = list_leadsheets()
    leadsheet_id = _unique_id(title, {s["id"] for s in sheets})
    sheet = _clean_doc(leadsheet_id, {"title": title, "elements": []})
    sheets.append(sheet)
    _save(sheets)
    data_store.commit_and_push(f"Add lead sheet '{sheet['title']}'")
    return sheet


def update_leadsheet(leadsheet_id: str, doc: dict) -> dict:
    sheets = list_leadsheets()
    for i, sheet in enumerate(sheets):
        if sheet["id"] == leadsheet_id:
            cleaned = _clean_doc(leadsheet_id, doc)
            sheets[i] = cleaned
            _save(sheets)
            data_store.commit_and_push(f"Update lead sheet '{cleaned['title']}'")
            return cleaned
    raise KeyError(leadsheet_id)


def delete_leadsheet(leadsheet_id: str) -> None:
    sheets = list_leadsheets()
    remaining = [s for s in sheets if s["id"] != leadsheet_id]
    if len(remaining) == len(sheets):
        raise KeyError(leadsheet_id)
    _save(remaining)
    data_store.commit_and_push("Remove lead sheet")


def import_leadsheet(doc: dict) -> dict:
    title = str(doc.get("title") or "").strip()
    if not title:
        raise ValueError("Sheet title can't be empty.")
    sheets = list_leadsheets()
    leadsheet_id = _unique_id(title, {s["id"] for s in sheets})
    cleaned = _clean_doc(leadsheet_id, doc)
    sheets.append(cleaned)
    _save(sheets)
    data_store.commit_and_push(f"Import lead sheet '{cleaned['title']}'")
    return cleaned

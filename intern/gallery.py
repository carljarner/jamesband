"""Gallery: photos/videos the band uploads, and the fixed background photo
behind each section of the public site's one-page scroll. Setting a section's
background overwrites the exact file public/css/styles.css already points to
(e.g. images/dsbs_1.jpg), so the public site needs no changes to pick it up.
"""

import uuid
from datetime import datetime, timezone
from pathlib import Path

import data_store

INDEX_PATH = "gallery/index.json"
MEDIA_DIR = "gallery/media"

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # keep clips small -- this all lives in a git repo

CONTENT_TYPES = {
    "image/jpeg": ("image", "jpg"),
    "image/jpg": ("image", "jpg"),
    "image/png": ("image", "png"),
    "image/webp": ("image", "webp"),
    "video/mp4": ("video", "mp4"),
    "video/webm": ("video", "webm"),
    "video/quicktime": ("video", "mov"),
}

# Public site section -> the exact background file its CSS rule loads.
BACKGROUND_SLOTS = {
    "home": {"label": "Forside", "public_path": "images/dsbs_1.jpg"},
    "video": {"label": "Video", "public_path": "images/video-bg.png"},
    "koncept": {"label": "Koncept", "public_path": "images/koncept-bg.png"},
    "kontakt": {"label": "Kontakt", "public_path": "images/kontakt-bg.png"},
}


class GalleryError(Exception):
    """Raised for unsupported uploads or unknown items/slots."""


def _kind_and_ext(content_type: str) -> tuple[str, str]:
    entry = CONTENT_TYPES.get((content_type or "").lower())
    if not entry:
        raise GalleryError(f"Unsupported file type '{content_type}'. Use a photo or an mp4/webm/mov video.")
    return entry


def list_items() -> list[dict]:
    items = data_store.load_json(INDEX_PATH, default=[])
    return sorted(items, key=lambda item: item["uploaded_at"], reverse=True)


def _save(items: list[dict]) -> None:
    data_store.save_json(INDEX_PATH, items)


def add_item(file_bytes: bytes, content_type: str) -> dict:
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise GalleryError(
            f"File is too large ({len(file_bytes) // (1024 * 1024)}MB) -- keep uploads under "
            f"{MAX_UPLOAD_BYTES // (1024 * 1024)}MB."
        )
    kind, ext = _kind_and_ext(content_type)

    item_id = uuid.uuid4().hex[:8]
    filename = f"{item_id}.{ext}"
    path = data_store.DATA_DIR / MEDIA_DIR / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(file_bytes)

    item = {
        "id": item_id,
        "kind": kind,
        "filename": filename,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    items = list_items()
    items.append(item)
    _save(items)
    data_store.commit_and_push(f"Add gallery {kind} {item_id}")
    return item


def delete_item(item_id: str) -> None:
    items = list_items()
    remaining = [item for item in items if item["id"] != item_id]
    if len(remaining) == len(items):
        raise GalleryError(f"Unknown gallery item '{item_id}'.")
    removed = next(item for item in items if item["id"] == item_id)

    _save(remaining)

    path = data_store.DATA_DIR / MEDIA_DIR / removed["filename"]
    if path.exists():
        path.unlink()

    data_store.commit_and_push(f"Remove gallery item {item_id}")


def media_path(item_id: str):
    for item in list_items():
        if item["id"] == item_id:
            path = data_store.DATA_DIR / MEDIA_DIR / item["filename"]
            return path if path.exists() else None
    return None


def background_path(slot: str) -> Path:
    if slot not in BACKGROUND_SLOTS:
        raise GalleryError(f"Unknown background slot '{slot}'.")
    return data_store.REPO_DIR / "public" / BACKGROUND_SLOTS[slot]["public_path"]


def set_background(slot: str, item_id: str) -> dict:
    item = next((i for i in list_items() if i["id"] == item_id), None)
    if item is None:
        raise GalleryError(f"Unknown gallery item '{item_id}'.")
    if item["kind"] != "image":
        raise GalleryError("Only photos can be used as a background.")

    src = data_store.DATA_DIR / MEDIA_DIR / item["filename"]
    background_path(slot).write_bytes(src.read_bytes())

    data_store.commit_and_push(f"Set {BACKGROUND_SLOTS[slot]['label']} background to {item_id}")
    return {"slot": slot, "item": item}

"""Gallery: photos/videos the band uploads and can choose to publish to the
public site. Published items get copied to public/gallery/ and listed in
public/gallery/gallery.json, which the public site fetches at runtime.
"""

import json
import uuid
from datetime import datetime, timezone

import data_store

INDEX_PATH = "gallery/index.json"
MEDIA_DIR = "gallery/media"

PUBLIC_DIR = "gallery"
PUBLIC_MANIFEST = "gallery.json"

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


class GalleryError(Exception):
    """Raised for unsupported uploads or unknown items."""


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


def _public_dir():
    return data_store.REPO_DIR / "public" / PUBLIC_DIR


def sync_public() -> None:
    """Mirror published items into public/gallery/ and (re)write the manifest
    the public site fetches. Non-published/deleted items get their public
    copy removed."""
    items = list_items()
    public_dir = _public_dir()
    public_dir.mkdir(parents=True, exist_ok=True)

    published = [item for item in items if item.get("published")]
    keep_filenames = {item["filename"] for item in published}

    for existing in public_dir.iterdir():
        if existing.is_file() and existing.name != PUBLIC_MANIFEST and existing.name not in keep_filenames:
            existing.unlink()

    for item in published:
        src = data_store.DATA_DIR / MEDIA_DIR / item["filename"]
        dest = public_dir / item["filename"]
        if src.exists():
            dest.write_bytes(src.read_bytes())

    manifest = [
        {"id": item["id"], "kind": item["kind"], "filename": item["filename"]}
        for item in published
    ]
    (public_dir / PUBLIC_MANIFEST).write_text(json.dumps(manifest, indent=2))


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
        "published": False,
    }
    items = list_items()
    items.append(item)
    _save(items)
    sync_public()
    data_store.commit_and_push(f"Add gallery {kind} {item_id}")
    return item


def set_published(item_id: str, published: bool) -> dict:
    items = list_items()
    for item in items:
        if item["id"] == item_id:
            item["published"] = published
            _save(items)
            sync_public()
            data_store.commit_and_push(
                f"{'Publish' if published else 'Unpublish'} gallery item {item_id}"
            )
            return item
    raise GalleryError(f"Unknown gallery item '{item_id}'.")


def delete_item(item_id: str) -> None:
    items = list_items()
    remaining = [item for item in items if item["id"] != item_id]
    if len(remaining) == len(items):
        raise GalleryError(f"Unknown gallery item '{item_id}'.")
    removed = next(item for item in items if item["id"] == item_id)

    _save(remaining)
    sync_public()

    media_path = data_store.DATA_DIR / MEDIA_DIR / removed["filename"]
    if media_path.exists():
        media_path.unlink()

    data_store.commit_and_push(f"Remove gallery item {item_id}")


def media_path(item_id: str):
    for item in list_items():
        if item["id"] == item_id:
            path = data_store.DATA_DIR / MEDIA_DIR / item["filename"]
            return path if path.exists() else None
    return None

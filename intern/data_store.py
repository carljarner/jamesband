"""Flat-file JSON/media storage on the server's persistent disk.

DATA_DIR holds everything the app writes:
  <DATA_DIR>/...            internal data (setlists, repertoire, gallery, ...)
  <DATA_DIR>/public/        files the public site loads from this app:
                            repertoire.json and images/<background files>

Production: DATA_DIR=/data, bind-mounted from /srv/jamesband/data on the
server, so it survives redeploys and is covered by the nightly backup.
Local dev: defaults to ./data next to this file (gitignored).

If DATA_DIR is empty on startup and differs from ./data, the contents of
./data (when present) are copied in once as a seed. The Docker image
excludes data/ (.dockerignore), so production never seeds from the image.
"""

import json
import os
import shutil
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DATA_DIR", HERE / "data")).resolve()
PUBLIC_DIR = DATA_DIR / "public"
_SEED_DIR = (HERE / "data").resolve()

_write_lock = threading.Lock()


def _seed_if_empty() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if _SEED_DIR != DATA_DIR and _SEED_DIR.is_dir() and not any(DATA_DIR.iterdir()):
        shutil.copytree(_SEED_DIR, DATA_DIR, dirs_exist_ok=True)


_seed_if_empty()


def load_json(relative_path: str, default=None):
    path = DATA_DIR / relative_path
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic_write(path: Path, data: bytes) -> None:
    """Write to a temp file in the same folder, then rename over the target,
    so a crash mid-write never leaves a half-written file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock:
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


def save_json(relative_path: str, data) -> None:
    _atomic_write(DATA_DIR / relative_path, json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8"))


def save_bytes(path: Path, data: bytes) -> None:
    _atomic_write(path, data)


def commit_and_push(message: str) -> None:
    """No-op since the move off git: every save above is already persistent.
    Kept so the existing callers don't need to change."""
    return None
"""Flat-file JSON/image storage under data/, persisted by committing to git.

Render's filesystem is ephemeral, so anything written under DATA_DIR must be
pushed back to the repo to survive a redeploy. Call commit_and_push() after
any write (adding a chord, tagging a song, etc.) — writes here are infrequent
enough that commit-per-write is not a performance concern.

The Docker build context is just intern/ (see Dockerfile), so the running
container has no .git / repo root baked in — on Render we clone a working
copy at startup instead and read/write data there.

Requires these env vars on Render (not needed for local dev):
  GIT_REMOTE      e.g. https://x-access-token:<token>@github.com/you/repo.git
  GIT_USER_NAME   committer name for automated commits
  GIT_USER_EMAIL  committer email for automated commits
"""

import json
import os
import subprocess
from pathlib import Path

GIT_REMOTE = os.environ.get("GIT_REMOTE")
GIT_USER_NAME = os.environ.get("GIT_USER_NAME", "intern-bot")
GIT_USER_EMAIL = os.environ.get("GIT_USER_EMAIL", "intern-bot@localhost")

if GIT_REMOTE:
    REPO_DIR = Path("/tmp/data-repo")
    if not (REPO_DIR / ".git").exists():
        subprocess.run(
            ["git", "clone", "--depth", "1", GIT_REMOTE, str(REPO_DIR)], check=True
        )
    DATA_DIR = REPO_DIR / "intern" / "data"
else:
    # Local dev: read/write the working copy already on disk, no cloning.
    REPO_DIR = Path(__file__).parent.parent
    DATA_DIR = Path(__file__).parent / "data"


def load_json(relative_path: str, default=None):
    path = DATA_DIR / relative_path
    if not path.exists():
        return default
    return json.loads(path.read_text())


def save_json(relative_path: str, data) -> None:
    path = DATA_DIR / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def commit_and_push(message: str) -> None:
    if not GIT_REMOTE:
        return  # local dev without a configured remote: skip silently

    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": GIT_USER_NAME,
        "GIT_AUTHOR_EMAIL": GIT_USER_EMAIL,
        "GIT_COMMITTER_NAME": GIT_USER_NAME,
        "GIT_COMMITTER_EMAIL": GIT_USER_EMAIL,
    }
    subprocess.run(["git", "add", "intern/data"], cwd=REPO_DIR, check=True)
    result = subprocess.run(["git", "commit", "-m", message], cwd=REPO_DIR, env=env)
    if result.returncode != 0:
        return  # nothing to commit
    subprocess.run(["git", "push", GIT_REMOTE, "HEAD:main"], cwd=REPO_DIR, check=True)

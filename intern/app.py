import hashlib
import json
import os
import secrets
from datetime import date
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

import chords
import gallery
import gig_bundle
import leadsheets
import leadsheets_remote
import lyrics
import lyrics_import
import repertoire
import setlist
import setlists
import data_store

# INTERN_PASSWORD may hold multiple comma-separated passwords, e.g.
# "bryllupsband,sommerturne2027" — any of them logs in, no per-person identity.
VALID_PASSWORDS = [p.strip() for p in os.environ["INTERN_PASSWORD"].split(",") if p.strip()]
SESSION_SECRET = os.environ["SESSION_SECRET"]



def _static_version() -> str:
    """Short hash of everything under static/, so URLs like
    /static/style.css?v=<hash> change whenever a deploy changes a file."""
    digest = hashlib.sha1()
    for path in sorted(Path("static").rglob("*")):
        if path.is_file():
            digest.update(str(path).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


class VersionedStaticFiles(StaticFiles):
    """Versioned requests (?v=...) are cached for good; the URL changes on
    the next deploy. Unversioned ones keep the default revalidation."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if b"v=" in scope.get("query_string", b""):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


app = FastAPI()
app.mount("/static", VersionedStaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
templates.env.globals["static_version"] = _static_version()

DA_MONTHS_ABBR = (
    "jan.", "feb.", "mar.", "apr.", "maj", "jun.",
    "jul.", "aug.", "sep.", "okt.", "nov.", "dec.",
)


def format_date_da(value: str) -> str:
    """Format an ISO date string as e.g. '5. sep. 2026'."""
    if not value:
        return ""
    try:
        d = date.fromisoformat(value)
    except ValueError:
        return value
    return f"{d.day}. {DA_MONTHS_ABBR[d.month - 1]} {d.year}"


templates.env.filters["dadate"] = format_date_da
templates.env.filters["offsetlabel"] = chords.offset_label


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    public = path == "/login" or path.startswith("/static/") or path.startswith("/public/")
    if not public and not request.session.get("authed"):
        return RedirectResponse("/login")
    return await call_next(request)


# Added after the decorator-based middleware above so it ends up outermost in
# the stack (Starlette wraps in reverse add-order) — request.session must be
# populated before require_login() reads it.
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET)


@app.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    return templates.TemplateResponse(request, "login.html", {"error": None})


@app.post("/login")
async def login(request: Request, password: str = Form(...)):
    if any(secrets.compare_digest(password, valid) for valid in VALID_PASSWORDS):
        request.session["authed"] = True
        return RedirectResponse("/gigs", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "Wrong password"}, status_code=401
    )


@app.get("/")
async def home():
    return RedirectResponse("/gigs")


# Old bookmarks: "Setlists" (gig history) was renamed "Gigs".
@app.get("/setlists")
async def setlists_redirect():
    return RedirectResponse("/gigs", status_code=301)


@app.get("/setlists/new")
async def setlists_new_redirect():
    return RedirectResponse("/gigs/new", status_code=301)


@app.get("/setlists/{setlist_id}")
async def setlists_edit_redirect(setlist_id: str):
    return RedirectResponse(f"/gigs/{setlist_id}", status_code=301)


@app.post("/setlist/master-songbook")
async def setlist_master_songbook(doc_url: str = Form(...)):
    try:
        setlist.set_master_songbook_url(doc_url)
    except ValueError as exc:
        return Response(content=str(exc), status_code=400)
    return {"doc_url": setlist.get_master_songbook_url()}


@app.post("/setlist/sync")
async def setlist_sync(doc_url: str = Form(...)):
    try:
        return setlist.sync(doc_url)
    except setlist.SyncError as exc:
        return Response(content=str(exc), status_code=400)


@app.post("/setlist/alias")
async def setlist_alias(setlist_title: str = Form(...), doc_title: str = Form(...)):
    try:
        setlist.set_alias(setlist_title, doc_title)
    except ValueError as exc:
        return Response(content=str(exc), status_code=400)
    return {"setlist_title": setlist_title, "doc_title": doc_title}


@app.get("/setlist")
async def setlist_picker_redirect():
    return RedirectResponse("/gigs", status_code=301)


@app.get("/setlist/{gig_id}")
async def setlist_editor_redirect(gig_id: str):
    return RedirectResponse(f"/gigs/{gig_id}/setlist", status_code=301)


@app.get("/gigs/{gig_id}/setlist", response_class=HTMLResponse)
async def setlist_editor_page(request: Request, gig_id: str):
    try:
        gig = setlists.get_setlist(gig_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "setlist_editor.html",
        {
            "setlist": gig,
            "repertoire_songs_json": json.dumps(repertoire.list_songs()),
            "setlist_songs_json": json.dumps(gig["songs"]),
            "new_songs_json": json.dumps(leadsheets.upcoming_new_songs()),
            "master_songbook_url": setlist.get_master_songbook_url(),
            "songbook_json": json.dumps(setlist.get_songbook()),
            "aliases_json": json.dumps(setlist.get_aliases()),
        },
    )


@app.post("/setlist/{gig_id}")
async def setlist_editor_save(gig_id: str, songs: str = Form("[]")):
    try:
        song_list = json.loads(songs)
        setlists.update_setlist(gig_id, {}, song_list)
    except KeyError:
        raise HTTPException(status_code=404)
    except (json.JSONDecodeError, ValueError) as exc:
        return Response(content=str(exc), status_code=400)
    return Response(status_code=204)


@app.post("/setlist/{gig_id}/add-to-repertoire")
async def setlist_add_to_repertoire(gig_id: str):
    try:
        return setlists.add_to_repertoire(gig_id)
    except KeyError:
        raise HTTPException(status_code=404)


@app.get("/repertoire", response_class=HTMLResponse)
async def repertoire_page(request: Request):
    return templates.TemplateResponse(
        request, "repertoire.html", {"songs": repertoire.list_songs()}
    )


@app.post("/repertoire")
async def repertoire_create(request: Request):
    body = await request.json()
    if not str(body.get("title") or "").strip():
        return Response(content="Song title can't be empty.", status_code=400)
    try:
        return repertoire.add_song(body)
    except ValueError as exc:
        return Response(content=str(exc), status_code=400)


@app.post("/repertoire/{song_id}")
async def repertoire_update(song_id: str, request: Request):
    try:
        body = await request.json()
        repertoire.update_song(song_id, body)
    except KeyError:
        raise HTTPException(status_code=404)
    except (ValueError, TypeError) as exc:
        return Response(content=str(exc), status_code=400)
    return Response(status_code=204)


@app.post("/repertoire/{song_id}/delete")
async def repertoire_delete(song_id: str):
    try:
        repertoire.delete_song(song_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return Response(status_code=204)


@app.get("/gigs", response_class=HTMLResponse)
async def gigs_page(request: Request):
    upcoming, past = setlists.split_upcoming_past(setlists.list_setlists())
    return templates.TemplateResponse(
        request, "gigs.html", {"upcoming_setlists": upcoming, "past_setlists": past}
    )


@app.get("/gigs/new", response_class=HTMLResponse)
async def gigs_new_page(request: Request):
    return templates.TemplateResponse(request, "gig_form.html", {"setlist": None})


@app.post("/gigs")
async def gigs_create(
    date: str = Form(...),
    venue: str = Form(""),
    lineup: str = Form(""),
    notes: str = Form(""),
):
    if not date.strip():
        return Response(content="Date can't be empty.", status_code=400)
    setlist_record = setlists.add_setlist(
        {"date": date, "venue": venue, "lineup": lineup, "notes": notes}, []
    )
    return setlist_record


@app.get("/gigs/{gig_id}", response_class=HTMLResponse)
async def gigs_edit_page(request: Request, gig_id: str):
    try:
        setlist_data = setlists.get_setlist(gig_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "gig_form.html",
        {"setlist": setlist_data},
    )


@app.post("/gigs/{gig_id}")
async def gigs_update(
    gig_id: str,
    date: str = Form(...),
    venue: str = Form(""),
    lineup: str = Form(""),
    notes: str = Form(""),
):
    if not date.strip():
        return Response(content="Date can't be empty.", status_code=400)
    try:
        setlists.update_setlist(
            gig_id, {"date": date, "venue": venue, "lineup": lineup, "notes": notes}, None
        )
    except KeyError:
        raise HTTPException(status_code=404)
    return Response(status_code=204)


@app.post("/gigs/{gig_id}/delete")
async def gigs_delete(gig_id: str):
    try:
        setlists.delete_setlist(gig_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return RedirectResponse("/gigs", status_code=303)


@app.get("/gigs/{gig_id}/leadsheets", response_class=HTMLResponse)
async def gigs_leadsheets(
    request: Request, gig_id: str, mode: str = "setlist", picks: str | None = None
):
    # Lead sheets are only drawn in the browser, so this page draws each
    # song's sheet (as gig_bundle plans it) and builds the PDF there.
    # `picks` ("0.signe,3.jonas,…": setlist row and singer) is the gig
    # page's Custom selection.
    picked = None
    if picks is not None:
        picked = {}
        for part in picks.split(","):
            index, _, singer = part.partition(".")
            if index.isdigit():
                picked[int(index)] = singer if singer in gig_bundle.SINGER_NAMES else ""
    try:
        gig = setlists.get_setlist(gig_id)
        plan = gig_bundle.build_leadsheet_plan(
            gig_id, mode if mode in gig_bundle.LEADSHEET_MODES else "setlist", picked
        )
    except KeyError:
        raise HTTPException(status_code=404)
    plan["subtitle"] = " · ".join(
        part for part in (gig.get("venue"), format_date_da(gig.get("date", ""))) if part
    )
    return templates.TemplateResponse(
        request,
        "leadsheets_bundle.html",
        {"gig": gig, "plan": plan, "plan_json": json.dumps(plan).replace("</", "<\\/")},
    )


@app.get("/gigs/{gig_id}/live", response_class=HTMLResponse)
async def gigs_live(request: Request, gig_id: str):
    # On stage: the gig's lead sheets on screen one at a time, in the
    # singers' keys, with the setlist alongside to jump around in.
    try:
        gig = setlists.get_setlist(gig_id)
        plan = gig_bundle.build_leadsheet_plan(gig_id, "transposed")
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "gig_live.html",
        {"gig": gig, "plan": plan, "plan_json": json.dumps(plan).replace("</", "<\\/")},
    )


@app.get("/gigs/{gig_id}/lyrics")
async def gigs_lyrics(gig_id: str):
    try:
        pdf_bytes, _missing = gig_bundle.build_lyrics_bundle(gig_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="lyrics.pdf"'},
    )


def _library_sections(docs: list[dict], by_song: dict, by_new: dict) -> dict:
    """The Lead Sheets and Lyrics pages' sections: upcoming new songs and
    repertoire songs, each with its doc (if any), plus docs not connected
    to a song shown elsewhere."""
    songs = repertoire.list_songs()
    new_songs = [
        dict(song, doc=by_new.get(song["title"].strip().casefold()))
        for song in leadsheets.upcoming_new_songs()
    ]
    shown = {d["id"] for d in by_song.values()} | {s["doc"]["id"] for s in new_songs if s["doc"]}
    return {
        "new_songs": new_songs,
        "upcoming_gigs": setlists.split_upcoming_past(setlists.list_setlists())[0],
        "with_doc": [dict(song, doc=by_song[song["id"]]) for song in songs if song["id"] in by_song],
        "missing": [song for song in songs if song["id"] not in by_song],
        "unlinked": [d for d in docs if d["id"] not in shown],
    }


@app.get("/leadsheets", response_class=HTMLResponse)
async def leadsheets_page(request: Request):
    leadsheets.auto_link()
    sections = _library_sections(leadsheets.list_leadsheets(), leadsheets.links(), leadsheets.new_song_links())
    return templates.TemplateResponse(request, "leadsheets.html", sections)


# Sheets are made on leadsheets.dk; here the band imports read-only copies
# of them and refreshes those when they change there.
@app.get("/leadsheets/available")
async def leadsheets_available():
    """The leadsheets.dk sheets not imported yet, for the "+" picker."""
    try:
        remote = await run_in_threadpool(leadsheets_remote.list_sheets)
    except leadsheets_remote.RemoteError as exc:
        return Response(content=str(exc), status_code=502)
    imported = leadsheets.imported_source_ids()
    available = [
        {"id": s.get("id", ""), "title": s.get("title", ""), "artist": s.get("artist", "")}
        for s in remote
        if s.get("id") and s["id"] not in imported
    ]
    return sorted(available, key=lambda s: s["title"].casefold())


@app.post("/leadsheets/import")
async def leadsheets_import(request: Request):
    body = await request.json()
    ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        return Response(content="Pick the sheets to import.", status_code=400)
    imported, errors = [], []
    already = leadsheets.imported_source_ids()
    for source_id in dict.fromkeys(ids):
        if source_id in already:
            continue
        try:
            doc = await run_in_threadpool(leadsheets_remote.get_sheet, source_id)
            imported.append(leadsheets.import_sheet(doc))
        except (leadsheets_remote.RemoteError, ValueError) as exc:
            errors.append({"id": source_id, "error": str(exc)})
    leadsheets.auto_link()
    return {"imported": imported, "errors": errors}


@app.post("/leadsheets/refresh")
async def leadsheets_refresh():
    """Bring every copy whose leadsheets.dk version changed up to date."""
    try:
        remote = await run_in_threadpool(leadsheets_remote.list_sheets)
    except leadsheets_remote.RemoteError as exc:
        return Response(content=str(exc), status_code=502)
    stale, gone = leadsheets.stale_sheets(remote)
    updated, errors = [], []
    for sheet in stale:
        try:
            doc = await run_in_threadpool(leadsheets_remote.get_sheet, leadsheets.source_of(sheet))
            leadsheets.reset_from_source(sheet["id"], doc)
            updated.append(sheet["title"])
        except leadsheets_remote.NotFound:
            gone.append(sheet)
        except (leadsheets_remote.RemoteError, ValueError) as exc:
            errors.append({"title": sheet["title"], "error": str(exc)})
    leadsheets.auto_link()
    return {"updated": updated, "gone": [s["title"] for s in gone], "errors": errors}


@app.get("/leadsheets/{leadsheet_id}", response_class=HTMLResponse)
async def leadsheet_page(request: Request, leadsheet_id: str):
    leadsheets.auto_link()
    try:
        sheet = leadsheets.get_leadsheet(leadsheet_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "leadsheet_editor.html",
        {
            "sheet": sheet,
            "sheet_json": json.dumps(sheet),
            "song_choices_json": json.dumps(_song_choices(leadsheets.links(), leadsheets.new_song_links())),
        },
    )


def _song_choices(linked: dict, linked_new: dict) -> dict:
    """The songs a sheet's or lyrics' "Song" dropdown offers -- upcoming new
    songs and the repertoire -- each with the doc of that kind it's already
    connected to (if any), given links() and new_song_links()."""

    def sheet_of(doc):
        return {"sheet_id": doc["id"], "sheet_title": doc["title"]} if doc else {"sheet_id": None, "sheet_title": None}

    return {
        "new_songs": [
            {"title": song["title"], "artist": song["artist"], "key": song.get("key") or "",
             **sheet_of(linked_new.get(song["title"].strip().casefold()))}
            for song in leadsheets.upcoming_new_songs()
        ],
        "repertoire": [
            {
                "id": song["id"],
                "title": song["title"],
                "artist": song.get("artist", ""),
                "key": song.get("key", ""),
                **sheet_of(linked.get(song["id"])),
            }
            for song in repertoire.list_songs()
        ],
    }


@app.post("/leadsheets/{leadsheet_id}/link")
async def leadsheet_link(leadsheet_id: str, request: Request):
    """Connect a sheet by hand: {repertoire_id}, {new_song} or {} for none."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Malformed request.")
        leadsheets.set_link(leadsheet_id, body.get("repertoire_id"), body.get("new_song"))
    except KeyError:
        raise HTTPException(status_code=404)
    except (ValueError, TypeError) as exc:
        return Response(content=str(exc), status_code=400)
    return Response(status_code=204)


@app.post("/leadsheets/{leadsheet_id}/delete")
async def leadsheet_delete(leadsheet_id: str):
    try:
        leadsheets.delete_leadsheet(leadsheet_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return RedirectResponse("/leadsheets", status_code=303)


# ── Lyrics ─────────────────────────────────────────────────────────────
# Written here, in the browser (static/lyrics-editor.js), one doc per song.

@app.get("/lyrics", response_class=HTMLResponse)
async def lyrics_page(request: Request):
    lyrics.auto_link()
    sections = _library_sections(lyrics.list_lyrics(), lyrics.links(), lyrics.new_song_links())
    sections["import_doc_url"] = lyrics_import.get_doc_url()
    return templates.TemplateResponse(request, "lyrics.html", sections)


def _lyrics_editor(request: Request, doc: dict):
    return templates.TemplateResponse(
        request,
        "lyrics_editor.html",
        {
            "doc": doc,
            "doc_json": json.dumps(doc).replace("</", "<\\/"),
            "song_choices_json": json.dumps(
                _song_choices(lyrics.links(), lyrics.new_song_links())
            ).replace("</", "<\\/"),
        },
    )


@app.get("/lyrics/new", response_class=HTMLResponse)
async def lyrics_new(request: Request, song: str = "", new_song: str = ""):
    """The editor for lyrics not saved yet -- for a song when `song` (a
    repertoire id) or `new_song` (an upcoming new song's title) is given.
    The first save creates them."""
    doc = {"id": None, "title": "", "artist": "", "key": "", "blocks": [], "repertoire_id": None}
    if song:
        match = next((s for s in repertoire.list_songs() if s["id"] == song), None)
        if match:
            existing = lyrics.links().get(song)
            if existing:
                return RedirectResponse(f"/lyrics/{existing['id']}", status_code=303)
            doc.update(title=match["title"], artist=match.get("artist", ""), key=match.get("key", ""), repertoire_id=song)
    elif new_song:
        folded = new_song.strip().casefold()
        match = next((s for s in leadsheets.upcoming_new_songs() if s["title"].strip().casefold() == folded), None)
        if match:
            existing = lyrics.new_song_links().get(folded)
            if existing:
                return RedirectResponse(f"/lyrics/{existing['id']}", status_code=303)
            doc.update(title=match["title"], artist=match.get("artist") or "", key=match.get("key") or "", new_song=match["title"])
    return _lyrics_editor(request, doc)


@app.post("/lyrics")
async def lyrics_create(request: Request):
    try:
        return lyrics.create(await request.json())
    except (ValueError, TypeError) as exc:
        return Response(content=str(exc), status_code=400)


@app.post("/lyrics/import/preview")
async def lyrics_import_preview(request: Request):
    """The songs in the band's Google Doc, each with the song it most
    likely is, for the Lyrics page's import list."""
    try:
        body = await request.json()
        doc_url = str(body.get("doc_url") or "").strip() if isinstance(body, dict) else ""
        if not doc_url:
            raise ValueError("Paste the Google Doc link.")
        html = await run_in_threadpool(lyrics_import.fetch_doc_html, doc_url)
    except (ValueError, setlist.SyncError) as exc:
        return Response(content=str(exc), status_code=400)
    lyrics_import.set_doc_url(doc_url)
    songs = lyrics_import.parse(html)
    lyrics_import.suggest(songs, repertoire.list_songs(), leadsheets.upcoming_new_songs(), lyrics.list_lyrics())
    return {"songs": songs, "choices": _song_choices(lyrics.links(), lyrics.new_song_links())}


@app.post("/lyrics/import")
async def lyrics_import_songs(request: Request):
    """Creates lyrics for the picked songs: [{title, key, blocks,
    repertoire_id | new_song}]. A song that already has lyrics is refused
    (lyrics.create), never overwritten."""
    body = await request.json()
    songs = body.get("songs") if isinstance(body, dict) else None
    if not isinstance(songs, list):
        return Response(content="Pick the songs to import.", status_code=400)
    by_id = {song["id"]: song for song in repertoire.list_songs()}
    new_by_title = {s["title"].strip().casefold(): s for s in leadsheets.upcoming_new_songs()}
    created, errors = [], []
    for song in songs:
        if not isinstance(song, dict):
            continue
        doc = {
            "title": song.get("title"),
            "artist": "",
            "key": song.get("key") or "",
            "blocks": song.get("blocks", []),
            "repertoire_id": song.get("repertoire_id"),
            "new_song": song.get("new_song"),
        }
        target = by_id.get(doc["repertoire_id"]) or new_by_title.get(str(doc["new_song"] or "").strip().casefold())
        if target:
            doc["title"] = target["title"]
            doc["artist"] = target.get("artist") or ""
            doc["key"] = doc["key"] or target.get("key") or ""
        if not target and lyrics_import.already_imported(str(doc["title"] or ""), lyrics.list_lyrics()):
            errors.append({"title": str(doc["title"]), "error": "already imported"})
            continue
        try:
            created.append(lyrics.create(doc)["title"])
        except (ValueError, TypeError) as exc:
            errors.append({"title": str(doc["title"] or "?"), "error": str(exc)})
    return {"created": created, "errors": errors}


@app.get("/lyrics/{lyrics_id}", response_class=HTMLResponse)
async def lyrics_edit_page(request: Request, lyrics_id: str):
    try:
        doc = lyrics.get_lyrics(lyrics_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return _lyrics_editor(request, doc)


@app.post("/lyrics/{lyrics_id}")
async def lyrics_save(lyrics_id: str, request: Request):
    try:
        doc = lyrics.save(lyrics_id, await request.json())
    except KeyError:
        raise HTTPException(status_code=404)
    except (ValueError, TypeError) as exc:
        return Response(content=str(exc), status_code=400)
    return {"updated_at": doc["updated_at"]}


@app.post("/lyrics/{lyrics_id}/link")
async def lyrics_link(lyrics_id: str, request: Request):
    """Connect lyrics by hand: {repertoire_id}, {new_song} or {} for none."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Malformed request.")
        lyrics.set_link(lyrics_id, body.get("repertoire_id"), body.get("new_song"))
    except KeyError:
        raise HTTPException(status_code=404)
    except (ValueError, TypeError) as exc:
        return Response(content=str(exc), status_code=400)
    return Response(status_code=204)


@app.post("/lyrics/{lyrics_id}/delete")
async def lyrics_delete(lyrics_id: str):
    try:
        lyrics.delete(lyrics_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return RedirectResponse("/lyrics", status_code=303)


@app.get("/gallery", response_class=HTMLResponse)
async def gallery_page(request: Request, error: str = None):
    return templates.TemplateResponse(
        request,
        "gallery.html",
        {
            "items": gallery.list_items(),
            "background_slots": [
                {"key": key, **slot} for key, slot in gallery.BACKGROUND_SLOTS.items()
            ],
            "error": error,
        },
    )


@app.post("/gallery")
async def gallery_upload(photo: UploadFile = File(...)):
    try:
        file_bytes = await photo.read()
        gallery.add_item(file_bytes, photo.content_type)
    except gallery.GalleryError as exc:
        return RedirectResponse(f"/gallery?error={quote(str(exc))}", status_code=303)
    return RedirectResponse("/gallery", status_code=303)


@app.get("/gallery/background/{slot}")
async def gallery_background(slot: str):
    try:
        path = gallery.background_path(slot)
    except gallery.GalleryError:
        raise HTTPException(status_code=404)
    if not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path)


@app.post("/gallery/background/{slot}")
async def gallery_set_background(slot: str, item_id: str = Form(...)):
    try:
        return gallery.set_background(slot, item_id)
    except gallery.GalleryError as exc:
        return Response(content=str(exc), status_code=400)


@app.post("/gallery/{item_id}/delete")
async def gallery_delete(item_id: str):
    try:
        gallery.delete_item(item_id)
    except gallery.GalleryError:
        raise HTTPException(status_code=404)
    return Response(status_code=204)


@app.get("/gallery/media/{item_id}")
async def gallery_media(item_id: str):
    path = gallery.media_path(item_id)
    if not path:
        raise HTTPException(status_code=404)
    return FileResponse(path)


# ── Public endpoints for the GitHub Pages site (no login) ─────────────
# Only public-safe data: the repertoire export (title/artist/cover) and the
# four section background images. Everything else stays behind the login.
PUBLIC_IMAGE_NAMES = {
    slot["public_path"].split("/")[-1] for slot in gallery.BACKGROUND_SLOTS.values()
}


@app.get("/public/repertoire.json")
async def public_repertoire():
    path = data_store.PUBLIC_DIR / "repertoire.json"
    if not path.exists():
        repertoire.export_public()
    return FileResponse(
        path,
        media_type="application/json",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"},
    )


@app.get("/public/images/{name}")
async def public_image(name: str):
    path = data_store.PUBLIC_DIR / "images" / name
    if name not in PUBLIC_IMAGE_NAMES or not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=300"})

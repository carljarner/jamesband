import json
import os
import secrets
from datetime import date
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

import gallery
import gig_bundle
import leadsheets
import repertoire
import setlist
import setlists

# INTERN_PASSWORD may hold multiple comma-separated passwords, e.g.
# "bryllupsband,sommerturne2027" — any of them logs in, no per-person identity.
VALID_PASSWORDS = [p.strip() for p in os.environ["INTERN_PASSWORD"].split(",") if p.strip()]
SESSION_SECRET = os.environ["SESSION_SECRET"]

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

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


@app.middleware("http")
async def require_login(request: Request, call_next):
    public = request.url.path == "/login" or request.url.path.startswith("/static/")
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


@app.get("/setlist", response_class=HTMLResponse)
async def setlist_picker_page(request: Request):
    upcoming, past = setlists.split_upcoming_past(setlists.list_setlists())
    return templates.TemplateResponse(
        request, "setlist_picker.html", {"upcoming_setlists": upcoming, "past_setlists": past}
    )


@app.get("/setlist/{gig_id}", response_class=HTMLResponse)
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
    return repertoire.add_song(body)


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
async def gigs_leadsheets(request: Request, gig_id: str):
    # Intentionally deferred: this used to render a combined PDF via
    # chords.get_song()/transpose_song(), which were removed when lead
    # sheets moved to the browser-based builder (see leadsheets.py). No
    # server-side renderer exists yet for the new sheet model -- print each
    # song from its own editor (Print button) and combine by hand for now.
    try:
        setlists.get_setlist(gig_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request, "leadsheets_bundle_unavailable.html", {"gig_id": gig_id}
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


@app.get("/leadsheets", response_class=HTMLResponse)
async def leadsheets_page(request: Request):
    return templates.TemplateResponse(
        request, "leadsheets.html", {"sheets": leadsheets.list_leadsheets()}
    )


@app.post("/leadsheets")
async def leadsheets_create(request: Request):
    body = await request.json()
    try:
        sheet = leadsheets.add_leadsheet(body.get("title", ""))
    except ValueError as exc:
        return Response(content=str(exc), status_code=400)
    return sheet


@app.post("/leadsheets/import")
async def leadsheets_import(request: Request):
    body = await request.json()
    try:
        sheet = leadsheets.import_leadsheet(body)
    except ValueError as exc:
        return Response(content=str(exc), status_code=400)
    return sheet


@app.get("/leadsheets/{leadsheet_id}", response_class=HTMLResponse)
async def leadsheet_editor_page(request: Request, leadsheet_id: str):
    try:
        sheet = leadsheets.get_leadsheet(leadsheet_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "leadsheet_editor.html",
        {"sheet": sheet, "sheet_json": json.dumps(sheet)},
    )


@app.post("/leadsheets/{leadsheet_id}")
async def leadsheet_save(leadsheet_id: str, request: Request):
    try:
        body = await request.json()
        leadsheets.update_leadsheet(leadsheet_id, body)
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

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

import chords
import gallery
import repertoire
import scan_cleanup
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
        return RedirectResponse("/setlists", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "Wrong password"}, status_code=401
    )


@app.get("/")
async def home():
    return RedirectResponse("/setlists")


@app.get("/setlist", response_class=HTMLResponse)
async def setlist_page(request: Request, sync_error: str = None, build_error: str = None):
    return templates.TemplateResponse(
        request,
        "setlist.html",
        {
            "config": setlist.get_config(),
            "songbook": setlist.get_songbook(),
            "sync_error": sync_error,
            "build_error": build_error,
        },
    )


@app.post("/setlist/sync")
async def setlist_sync(doc_url: str = Form(...)):
    try:
        setlist.sync(doc_url)
    except setlist.SyncError as exc:
        return RedirectResponse(f"/setlist?sync_error={quote(str(exc))}", status_code=303)
    return RedirectResponse("/setlist", status_code=303)


@app.post("/setlist/build")
async def setlist_build(order: str = Form(...)):
    try:
        titles = json.loads(order)
        if not isinstance(titles, list) or not titles:
            raise setlist.SyncError("Add at least one song to tonight's order.")
        pdf_bytes = setlist.build_ordered_pdf(titles)
    except (setlist.SyncError, json.JSONDecodeError) as exc:
        return RedirectResponse(f"/setlist?build_error={quote(str(exc))}", status_code=303)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="setlist.pdf"'},
    )


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


@app.get("/setlists", response_class=HTMLResponse)
async def setlists_page(request: Request):
    upcoming, past = setlists.split_upcoming_past(setlists.list_setlists())
    return templates.TemplateResponse(
        request, "setlists.html", {"upcoming_setlists": upcoming, "past_setlists": past}
    )


@app.get("/setlists/new", response_class=HTMLResponse)
async def setlists_new_page(request: Request):
    return templates.TemplateResponse(
        request,
        "setlist_form.html",
        {
            "setlist": None,
            "repertoire_songs_json": json.dumps(repertoire.list_songs()),
            "setlist_songs_json": json.dumps([]),
        },
    )


@app.post("/setlists")
async def setlists_create(
    date: str = Form(...),
    venue: str = Form(""),
    lineup: str = Form(""),
    notes: str = Form(""),
    songs: str = Form("[]"),
):
    if not date.strip():
        return Response(content="Date can't be empty.", status_code=400)
    try:
        song_list = json.loads(songs)
        setlist = setlists.add_setlist(
            {"date": date, "venue": venue, "lineup": lineup, "notes": notes}, song_list
        )
    except (json.JSONDecodeError, ValueError) as exc:
        return Response(content=str(exc), status_code=400)
    return setlist


@app.get("/setlists/{setlist_id}", response_class=HTMLResponse)
async def setlists_edit_page(request: Request, setlist_id: str):
    try:
        setlist_data = setlists.get_setlist(setlist_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "setlist_form.html",
        {
            "setlist": setlist_data,
            "repertoire_songs_json": json.dumps(repertoire.list_songs()),
            "setlist_songs_json": json.dumps(setlist_data["songs"]),
        },
    )


@app.post("/setlists/{setlist_id}")
async def setlists_update(
    setlist_id: str,
    date: str = Form(...),
    venue: str = Form(""),
    lineup: str = Form(""),
    notes: str = Form(""),
    songs: str = Form("[]"),
):
    if not date.strip():
        return Response(content="Date can't be empty.", status_code=400)
    try:
        song_list = json.loads(songs)
        setlists.update_setlist(
            setlist_id, {"date": date, "venue": venue, "lineup": lineup, "notes": notes}, song_list
        )
    except KeyError:
        raise HTTPException(status_code=404)
    except (json.JSONDecodeError, ValueError) as exc:
        return Response(content=str(exc), status_code=400)
    return Response(status_code=204)


@app.post("/setlists/{setlist_id}/delete")
async def setlists_delete(setlist_id: str):
    try:
        setlists.delete_setlist(setlist_id)
    except KeyError:
        raise HTTPException(status_code=404)
    return RedirectResponse("/setlists", status_code=303)


@app.post("/setlists/{setlist_id}/add-to-repertoire")
async def setlists_add_to_repertoire(setlist_id: str):
    try:
        return setlists.add_to_repertoire(setlist_id)
    except KeyError:
        raise HTTPException(status_code=404)


@app.get("/leadsheets", response_class=HTMLResponse)
async def leadsheets_page(request: Request, error: str = None, scan_error: str = None):
    return templates.TemplateResponse(
        request,
        "leadsheets.html",
        {"songs": chords.list_songs(), "error": error, "scan_error": scan_error},
    )


@app.post("/scan/clean")
async def scan_clean(photo: UploadFile = File(...)):
    try:
        image_bytes = await photo.read()
        pdf_bytes = scan_cleanup.clean_scan(image_bytes)
    except scan_cleanup.CleanupError as exc:
        return RedirectResponse(f"/leadsheets?scan_error={quote(str(exc))}", status_code=303)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="chart.pdf"'},
    )


@app.get("/chords", response_class=HTMLResponse)
async def chords_page(request: Request, error: str = None):
    return templates.TemplateResponse(
        request, "chords.html", {"status": chords.library_status(), "error": error}
    )


@app.get("/chords/sheet")
async def chords_sheet():
    pdf_bytes = chords.generate_recording_sheet()
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="chord-recording-sheet.pdf"'},
    )


@app.post("/chords/import")
async def chords_import(kind: str = Form(...), photo: UploadFile = File(...)):
    try:
        image_bytes = await photo.read()
        chords.import_library_sheet(image_bytes, kind)
    except chords.ChordError as exc:
        return RedirectResponse(f"/chords?error={quote(str(exc))}", status_code=303)
    return RedirectResponse("/chords", status_code=303)


@app.get("/chords/image/{kind}/{name}")
async def chord_image(kind: str, name: str):
    path = chords.library_image_path(kind, name)
    if not path or not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png")


@app.post("/songs")
async def songs_create(title: str = Form(...), key: str = Form(...), photo: UploadFile = File(...)):
    try:
        image_bytes = await photo.read()
        slug = chords.create_song_draft(title, key, image_bytes)
    except (chords.ChordError, scan_cleanup.CleanupError) as exc:
        return RedirectResponse(f"/leadsheets?error={quote(str(exc))}", status_code=303)
    return RedirectResponse(f"/songs/{slug}/tag", status_code=303)


@app.get("/songs/{slug}/tag", response_class=HTMLResponse)
async def song_tag_page(request: Request, slug: str):
    song = chords.get_song(slug)
    if not song:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        request,
        "tag.html",
        {
            "slug": slug,
            "song": song,
            "chord_names": chords.CHORD_LABELS,
            "tags_json": json.dumps(song.get("chords", [])),
        },
    )


@app.post("/songs/{slug}/tag")
async def song_tag_save(slug: str, request: Request):
    try:
        body = await request.json()
        chords.save_song_tags(slug, body.get("chords", []))
    except (chords.ChordError, ValueError, TypeError) as exc:
        return Response(content=str(exc), status_code=400)
    return Response(status_code=204)


@app.get("/songs/{slug}/image/{which}")
async def song_image(slug: str, which: str):
    path = chords.song_image_path(slug, which)
    if not path:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png")


@app.post("/songs/{slug}/transpose")
async def song_transpose(slug: str, semitones: str = Form(""), target_key: str = Form("")):
    try:
        song = chords.get_song(slug)
        if not song:
            raise chords.ChordError(f"Unknown song '{slug}'.")
        if target_key.strip():
            n = chords.semitones_for_target_key(song["key"], target_key.strip())
        elif semitones.strip():
            n = int(semitones)
        else:
            raise chords.ChordError("Enter a semitone shift or a target key.")
        pdf_bytes = chords.transpose_song(slug, n)
    except (chords.ChordError, ValueError) as exc:
        return RedirectResponse(f"/leadsheets?error={quote(str(exc))}", status_code=303)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-transposed.pdf"'},
    )


@app.get("/gallery", response_class=HTMLResponse)
async def gallery_page(request: Request, error: str = None):
    return templates.TemplateResponse(
        request, "gallery.html", {"items": gallery.list_items(), "error": error}
    )


@app.post("/gallery")
async def gallery_upload(photo: UploadFile = File(...)):
    try:
        file_bytes = await photo.read()
        gallery.add_item(file_bytes, photo.content_type)
    except gallery.GalleryError as exc:
        return RedirectResponse(f"/gallery?error={quote(str(exc))}", status_code=303)
    return RedirectResponse("/gallery", status_code=303)


@app.post("/gallery/{item_id}/publish")
async def gallery_publish(item_id: str, published: bool = Form(...)):
    try:
        gallery.set_published(item_id, published)
    except gallery.GalleryError:
        raise HTTPException(status_code=404)
    return Response(status_code=204)


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

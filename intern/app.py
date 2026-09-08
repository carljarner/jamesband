import json
import os
import secrets
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

import chords
import scan_cleanup
import setlist

# INTERN_PASSWORD may hold multiple comma-separated passwords, e.g.
# "bryllupsband,sommerturne2027" — any of them logs in, no per-person identity.
VALID_PASSWORDS = [p.strip() for p in os.environ["INTERN_PASSWORD"].split(",") if p.strip()]
SESSION_SECRET = os.environ["SESSION_SECRET"]

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


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
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "Wrong password"}, status_code=401
    )


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request, "home.html", {})


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


@app.get("/scan", response_class=HTMLResponse)
async def scan_page(request: Request, error: str = None):
    return templates.TemplateResponse(request, "scan.html", {"error": error})


@app.post("/scan/clean")
async def scan_clean(photo: UploadFile = File(...)):
    try:
        image_bytes = await photo.read()
        pdf_bytes = scan_cleanup.clean_scan(image_bytes)
    except scan_cleanup.CleanupError as exc:
        return RedirectResponse(f"/scan?error={quote(str(exc))}", status_code=303)

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


@app.get("/songs", response_class=HTMLResponse)
async def songs_page(request: Request, error: str = None):
    return templates.TemplateResponse(
        request, "songs.html", {"songs": chords.list_songs(), "error": error}
    )


@app.post("/songs")
async def songs_create(title: str = Form(...), key: str = Form(...), photo: UploadFile = File(...)):
    try:
        image_bytes = await photo.read()
        slug = chords.create_song_draft(title, key, image_bytes)
    except (chords.ChordError, scan_cleanup.CleanupError) as exc:
        return RedirectResponse(f"/songs?error={quote(str(exc))}", status_code=303)
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
        return RedirectResponse(f"/songs?error={quote(str(exc))}", status_code=303)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-transposed.pdf"'},
    )

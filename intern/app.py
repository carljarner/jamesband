import json
import os
import secrets
from urllib.parse import quote

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

import setlist

# INTERN_PASSWORD may hold multiple comma-separated passwords, e.g.
# "bryllupsband,sommerturne2027" — any of them logs in, no per-person identity.
VALID_PASSWORDS = [p.strip() for p in os.environ["INTERN_PASSWORD"].split(",") if p.strip()]
SESSION_SECRET = os.environ["SESSION_SECRET"]

app = FastAPI()
templates = Jinja2Templates(directory="templates")


@app.middleware("http")
async def require_login(request: Request, call_next):
    public_paths = {"/login"}
    if request.url.path not in public_paths and not request.session.get("authed"):
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


# Feature routes (scan cleanup, chord library/transpose) get added here in
# later build phases.

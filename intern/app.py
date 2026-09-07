import os

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

INTERN_PASSWORD = os.environ["INTERN_PASSWORD"]
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
    if password == INTERN_PASSWORD:
        request.session["authed"] = True
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "Wrong password"}, status_code=401
    )


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request, "home.html", {})


# Feature routes (setlist generator, scan cleanup, chord library/transpose)
# get added here in later build phases.

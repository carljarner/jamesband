# Hosting setup

James Band runs as two parts from this one repo:

| Part | Folder | Hosted on | Address |
| --- | --- | --- | --- |
| Public page | `public/` | GitHub Pages | `https://jamesband.dk` |
| Intern app | `intern/` | Coolify on the Hetzner server `web-1` | `https://intern.jamesband.dk` |

DNS is on simply.com. The repo is `github.com/carljarner/jamesband`.

The public page is static. It loads `repertoire.json` and the four section
backgrounds from the intern app's public endpoints, so they're never stored
in git:

- `https://intern.jamesband.dk/public/repertoire.json` (title, artist and
  cover only; rebuilt whenever the repertoire changes)
- `https://intern.jamesband.dk/public/images/{dsbs_1.jpg, video-bg.png, koncept-bg.png, kontakt-bg.png}`
  (picked on the intern **Gallery** page for Forside, Video, Koncept and
  Kontakt)

All other intern data is behind the login.

## Deploys

- **Public page:** `.github/workflows/pages.yml` publishes `public/` on every
  push to `main` that changes `public/**` or the workflow. You can also start
  it by hand from the Actions tab.
- **Intern app:** Coolify redeploys on pushes to `main` that touch the app's
  code (see Watch Paths below).
- Saving something in the intern app writes to the server disk only. It never
  creates a GitHub commit.

## GitHub Pages

- Repo Settings → Pages → Source: **GitHub Actions** (not "Deploy from
  branch").
- Repo Settings → Pages → Custom domain: `jamesband.dk`. This must match
  `public/CNAME`.

## Coolify (intern app)

- Resource: **jamesband → production**, a Private Repository (with GitHub
  App) on repo `jamesband`, branch `main`.
- Build Pack: Dockerfile. Base Directory: `/intern`. Dockerfile Location:
  `/Dockerfile`. Ports Exposes: `10000`.
- Watch Paths: `intern/*.py`, `intern/requirements.txt`, `intern/Dockerfile`,
  `intern/.dockerignore`, `intern/templates/**`, `intern/static/**`.
- Persistent Storage: a directory mount from `/srv/jamesband/data` on the
  server to `/data` in the container. The nightly restic backup covers it.
- Domain: `https://intern.jamesband.dk`. Coolify issues the TLS certificate.
- Environment variables (runtime only, not build variables):
  - `INTERN_PASSWORD`: the band password. You can list several, separated
    by commas, and any one of them logs in.
  - `SESSION_SECRET`: a long random string
    (`python3 -c "import secrets; print(secrets.token_hex(32))"`). Changing it
    logs everyone out.
  - `DATA_DIR`: `/data`.
  - `LEADSHEETS_API_TOKEN`: one of leadsheets.dk's `API_TOKEN` values. The
    **+** button on the Lead Sheets page uses it to import sheets from
    leadsheets.dk. `LEADSHEETS_API_URL` defaults to `https://leadsheets.dk`.
    Set it only to point at a local copy while developing.

### Data on the server

Everything the app saves is stored under `/srv/jamesband/data` (`/data` in
the container): `repertoire/`, `songs/`, `setlist/`, `setlists/`,
`leadsheets/`, `gallery/`, and `public/` for the files the public page
loads. The Docker image leaves out `intern/data/` (see `.dockerignore`), so a
deploy never overwrites live data.

## DNS on simply.com

- Apex (`@`) → A records to GitHub Pages: `185.199.108.153`,
  `185.199.109.153`, `185.199.110.153`, `185.199.111.153`. Check GitHub's
  Pages docs if these ever change.
- `www` → CNAME → `carljarner.github.io`.
- `intern` → A → the server's IPv4 address (optionally also AAAA → its IPv6
  address).
- `coolify` → A → the server's IPv4 address, for the Coolify dashboard.

## Local development

Copy the live data down, then start the app:

```bash
rsync -a web-1:/srv/jamesband/data/ intern/data/
cd intern
INTERN_PASSWORD=dev SESSION_SECRET=dev uvicorn app:app --reload --port 10000
```

`INTERN_PASSWORD` and `SESSION_SECRET` are required. `DATA_DIR` defaults to
`intern/data`, which is gitignored. Lead sheet import also needs
`LEADSHEETS_API_TOKEN`.

The public page fetches its data from the live intern app, so you can open
`public/index.html` directly.

## Checking it works

- `https://jamesband.dk` loads, including the repertoire list and the
  section backgrounds.
- `https://intern.jamesband.dk` redirects to `/login`. A wrong password is
  rejected. A correct one goes to **Gigs**.
- A push that changes `public/` runs the Pages workflow successfully, and the
  live site updates.
- A push that changes the intern code makes Coolify redeploy.

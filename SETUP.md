# One-time hosting setup

Manual steps to wire up the split: public page on GitHub Pages, intern app
in Coolify on the Hetzner server `web-1`, DNS on simply.com. The full
server setup (firewall, Coolify, backups) is in `hosting.md`.

## 1. GitHub repo

- Create a repo (e.g. `github.com/<you>/james-band`) and push this folder to
  it. The `.github/workflows/pages.yml` workflow deploys `/public` on every
  push to `main`.
- Repo Settings → Pages → Source: "GitHub Actions" (not "Deploy from branch").
- Repo Settings → Pages → Custom domain: your apex domain (e.g. `example.com`).
  GitHub will show a DNS check — see step 3.

## 2. Coolify (intern app)

- In Coolify: **jamesband → production → + New → Private Repository (with
  GitHub App)**, repo `jamesband`, branch `main`.
- Build Pack: Dockerfile. Base Directory: `/intern`. Dockerfile Location:
  `/Dockerfile`. Ports Exposes: `10000`.
- Watch Paths, so only code changes redeploy:
  `intern/*.py`, `intern/requirements.txt`, `intern/Dockerfile`,
  `intern/templates/**`, `intern/static/**`.
- Persistent Storage: directory mount, source `/srv/jamesband/data`,
  destination `/data`. All app data lives there, not in git, and the
  nightly restic backup covers it.
- Environment variables (runtime only, not build variables):
  - `INTERN_PASSWORD`: the shared band password.
  - `SESSION_SECRET`: any long random string (`python3 -c "import secrets; print(secrets.token_hex(32))"`).
  - `DATA_DIR`: `/data`.
- Domains: `https://intern.<your-domain>`. Coolify issues the TLS cert once
  DNS resolves.
- The public site loads `repertoire.json` and the four section backgrounds
  from `https://intern.<your-domain>/public/`, so they stay out of this repo.
- For local development, copy the live data down:
  `scp -r web-1:/srv/jamesband/data intern/data`.

## 3. DNS on simply.com

In the simply.com DNS control panel for your domain, add:

- Apex (`@`) → A records pointing at GitHub Pages' IPs (currently
  `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` — double-check
  GitHub's own Pages docs for the current list before adding).
- `www` → CNAME → `<you>.github.io`.
- `intern` → A → the server's IPv4 address.

DNS propagation can take anywhere from minutes to a few hours. GitHub Pages
shows a pending/verified status for the custom domain, and Coolify gets the
intern certificate once it resolves.

## 4. Verify

- `https://<your-domain>` → public page loads.
- `https://intern.<your-domain>` → redirects to `/login`; wrong password
  rejected, correct password reaches the intern home page.
- Push a change to `/public` → confirm the Pages Actions run succeeds and the
  live site updates.
- Push a change to `/intern` code → confirm Coolify auto-deploys.
- Save something in the intern app → confirm it creates no GitHub commit.

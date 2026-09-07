# One-time hosting setup

Manual steps to wire up the split described in the plan (public page on
GitHub Pages, intern app on Render, DNS on simply.com). Code changes are
already done; this is account/dashboard configuration only.

## 1. GitHub repo

- Create a repo (e.g. `github.com/<you>/james-band`) and push this folder to
  it. The `.github/workflows/pages.yml` workflow deploys `/public` on every
  push to `main`.
- Repo Settings → Pages → Source: "GitHub Actions" (not "Deploy from branch").
- Repo Settings → Pages → Custom domain: your apex domain (e.g. `example.com`).
  GitHub will show a DNS check — see step 3.

## 2. Render (intern app)

- New → Web Service → connect the same GitHub repo.
- Root Directory: `intern`. Render will detect the `Dockerfile` automatically.
- Environment variables to set in the Render dashboard:
  - `INTERN_PASSWORD` — the shared band password.
  - `SESSION_SECRET` — any long random string (`python3 -c "import secrets; print(secrets.token_hex(32))"`).
  - `GIT_REMOTE` — `https://x-access-token:<TOKEN>@github.com/<you>/james-band.git`,
    where `<TOKEN>` is a fine-grained GitHub PAT scoped to just this repo with
    Contents: Read and write. This lets the intern app commit chord
    library/song data back to the repo (see `intern/data_store.py`).
  - `GIT_USER_NAME`, `GIT_USER_EMAIL` — used for the automated data commits.
- Once deployed, Render gives you a `<service>.onrender.com` URL — confirm the
  app loads and the login gate works before moving to DNS.
- Settings → Custom Domain → add `intern.<your-domain>`. Render will show the
  CNAME target to add (step 3) and auto-issues a TLS cert once DNS resolves.

## 3. DNS on simply.com

In the simply.com DNS control panel for your domain, add:

- Apex (`@`) → A records pointing at GitHub Pages' IPs (currently
  `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` — double-check
  GitHub's own Pages docs for the current list before adding).
- `www` → CNAME → `<you>.github.io`.
- `intern` → CNAME → the `<service>.onrender.com` hostname Render shows you.

DNS propagation can take anywhere from minutes to a few hours. Both GitHub
Pages and Render will show a pending/verified status for the custom domain
once it resolves.

## 4. Verify

- `https://<your-domain>` → public page loads.
- `https://intern.<your-domain>` → redirects to `/login`; wrong password
  rejected, correct password reaches the intern home page.
- Push a change to `/public` → confirm the Pages Actions run succeeds and the
  live site updates.
- Push a change to `/intern` → confirm Render auto-deploys.

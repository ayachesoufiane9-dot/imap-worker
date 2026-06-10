# Mail Finder Pro — IMAP Worker

Node service that handles IMAP (Cloudflare Workers can't open raw IMAP sockets).
Results stream to the UI via Supabase Realtime.

## Endpoints
- `POST /api/accounts/validate` `{ accountId }`
- `POST /api/search/start` `{ searchId }`
- `POST /api/capture/start` `{ captureId }`
- `POST /api/capture/stop` `{ captureId }`

All require `Authorization: Bearer <supabase-access-token>`.

## Local dev
```
cp .env.example .env
npm install
npm run dev
```

## Automated Deploy — GitHub Action

A workflow at `.github/workflows/deploy-imap-worker.yml` deploys the worker on every push to `main`.

### Setup
1. Push this repo to GitHub.
2. In Railway dashboard, create a project and an empty service named `imap-worker`.
3. Copy your Railway token (Account Settings → Tokens).
4. In your GitHub repo, go to **Settings → Secrets → Actions** and add `RAILWAY_TOKEN`.
5. In Railway, set these environment variables for the `imap-worker` service:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `ALLOWED_ORIGIN` (your Lovable app URL)
   - `PORT` = `8080`
6. Push to `main` — the Action will deploy automatically.

### Manual Deploy (Fly.io)
If you prefer Fly.io, the repo already includes `fly.toml`.
```bash
cd imap-worker
fly deploy
```

### One-click Railway (alternative)
If you prefer Railway's native GitHub integration instead of the Action:
1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Set the service root directory to `imap-worker`.
4. Add the same env vars listed above.

---

Uses `imapflow` with parallel `Promise.all` scans. Read-only — never sends mail.
App passwords live in `gmail_accounts.app_password` protected by RLS.

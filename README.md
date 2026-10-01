# Daily DB backup → Cloudflare R2 (Railway cron)

Runs once per schedule on [Railway](https://railway.com): dumps your database, gzip-compresses it, uploads to an R2 bucket, and optionally deletes backups older than `RETENTION_DAYS`.

Supports **PostgreSQL** and **MySQL** via `DATABASE_URL`.

## Railway setup

1. **New service** → connect this **GitHub repo** (do not use “deploy from source” with a raw `github.com/...` URL—that flow often fails). Use **Settings → Connect Repo** on the service.
2. **Settings → Build**
   - **Builder:** `Dockerfile` (required — the image installs `pg_dump` / `mysqldump`).
   - **Build command:** leave **empty** (Docker builds the image; no `npm build` step).
   - **Dockerfile path:** `Dockerfile` (repo root).
3. **Settings → Deploy**
   - **Start command:** leave empty (uses Dockerfile `CMD`) or `npm start`.
   - **Restart policy:** `Never`.
4. **Settings → Cron:** schedule, e.g. `*/5 * * * *` (every 5 minutes, UTC) for testing, then switch to daily.
5. **Variables:** set all R2 vars below; for `DATABASE_URL`, use **Add variable reference** from your Postgres/MySQL service.
6. Deploy until the latest deployment shows **Success**. Use **Run now** on the cron tab once — you should see `Starting … backup` in logs. If deploy fails, cron will show **skipped** until a deployment is ready.

### If cron says “skipped” or deploy fails

| Symptom | Fix |
|--------|-----|
| `There was an error deploying from source` | Connect the GitHub repo to the service; redeploy from the **Deployments** tab, not a pasted URL. |
| Build fails on `npm build` / missing build script | Clear **Build command** in Settings, or use `npm run build` (noop script in `package.json`). Prefer **Dockerfile** builder with an empty build command. |
| Cron skipped, no app logs | Last deployment is not **Success** — open build/deploy logs and fix that first. |
| `Missing required environment variable` | Add the missing var on **this** cron service (references count). |

## Cloudflare R2 setup

1. R2 → your bucket → note the bucket name.
2. **Manage R2 API tokens** → Create token with **Object Read & Write** on that bucket (or account-wide for simplicity).
3. Copy **Access Key ID**, **Secret Access Key**, and your **Account ID** (dashboard URL or R2 overview).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | `postgresql://...` or `mysql://...` |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Yes | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret |
| `R2_BUCKET_NAME` | Yes | Target bucket name |
| `R2_ENDPOINT` | No | Default: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `BACKUP_PREFIX` | No | Folder prefix in bucket (default: `db-backups`) |
| `RETENTION_DAYS` | No | Delete older objects under prefix (default: `14`, set `0` to disable) |

## Local test

```bash
npm install
# set env vars, then:
npm run backup
```

Requires `pg_dump` or `mysqldump` on your PATH (included in the Docker image on Railway).

## Restore (PostgreSQL example)

```bash
# download from R2, then:
gunzip -c backup.sql.gz | psql "$DATABASE_URL"
```

## Cron time

Set **Cron Schedule** in the Railway dashboard (Settings). Uses standard cron (UTC). Example: `0 3 * * *` = 03:00 UTC every day.

# Daily DB backup → Cloudflare R2 (Railway cron)

Runs once per schedule on [Railway](https://railway.com): dumps your database, gzip-compresses it, uploads to an R2 bucket, and optionally deletes backups older than `RETENTION_DAYS`.

Supports **PostgreSQL** and **MySQL** via `DATABASE_URL`.

## Railway setup

1. Create a **new service** from this repo (GitHub or `railway up`).
2. Open the service → **Settings** → enable **Cron Schedule** (or use `cronSchedule` in `railway.toml`). Default: `0 2 * * *` (02:00 UTC daily).
3. Set **variables** (see below). If the DB lives on Railway, use **Add variable reference** from your Postgres/MySQL service for `DATABASE_URL`.
4. Deploy. Each cron tick runs the container once; logs show success or errors.

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

Edit `cronSchedule` in `railway.toml` or the Railway dashboard. Uses standard cron (UTC). Example: `0 3 * * *` = 03:00 UTC every day.

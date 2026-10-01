import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

function requireEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function parseDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") {
    return { engine: "postgres", url };
  }
  if (scheme === "mysql" || scheme === "mysql2") {
    return { engine: "mysql", url: url.replace(/^mysql2:/, "mysql:") };
  }
  throw new Error(
    `Unsupported DATABASE_URL scheme "${scheme}". Use postgres or mysql.`
  );
}

async function dumpPostgres(databaseUrl, outputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pg_dump",
      ["--no-owner", "--no-acl", databaseUrl],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    const out = createWriteStream(outputPath);
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.stdout.pipe(out);
    child.on("error", reject);
    child.on("close", (code) => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function dumpMysql(databaseUrl, outputPath) {
  const parsed = new URL(databaseUrl);
  const args = [
    "--single-transaction",
    "--quick",
    "--host",
    parsed.hostname,
    "--port",
    parsed.port || "3306",
    "--user",
    decodeURIComponent(parsed.username),
  ];
  if (parsed.password) {
    args.push(`--password=${decodeURIComponent(parsed.password)}`);
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) throw new Error("DATABASE_URL must include a database name");
  args.push(dbName);

  await new Promise((resolve, reject) => {
    const child = spawn("mysqldump", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createWriteStream(outputPath);
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.stdout.pipe(out);
    child.on("error", reject);
    child.on("close", (code) => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(`mysqldump exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function gzipFile(inputPath, outputPath) {
  await pipeline(
    createReadStream(inputPath),
    createGzip({ level: 9 }),
    createWriteStream(outputPath)
  );
}

function buildR2Client() {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const endpoint =
    process.env.R2_ENDPOINT?.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`;

  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function uploadToR2(client, bucket, key, filePath) {
  const body = createReadStream(filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
    })
  );
}

async function pruneOldBackups(client, bucket, prefix, retentionDays) {
  if (retentionDays <= 0) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let continuationToken;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of list.Contents ?? []) {
      if (!obj.Key || !obj.LastModified) continue;
      if (obj.LastModified.getTime() >= cutoff) continue;
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key })
      );
      console.log(`Deleted old backup: ${obj.Key}`);
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const bucket = requireEnv("R2_BUCKET_NAME");
  const prefix = (process.env.BACKUP_PREFIX || "db-backups").replace(/\/+$/, "");
  const retentionDays = optionalInt("RETENTION_DAYS", 14);

  const { engine } = parseDatabaseUrl(databaseUrl);
  const stamp = timestampSlug();
  const baseName = `${engine}-${stamp}`;
  const sqlPath = join(tmpdir(), `backup-${randomBytes(8).toString("hex")}.sql`);
  const gzPath = `${sqlPath}.gz`;
  const objectKey = `${prefix}/${baseName}.sql.gz`;

  console.log(`Starting ${engine} backup → s3://${bucket}/${objectKey}`);

  try {
    if (engine === "postgres") {
      await dumpPostgres(databaseUrl, sqlPath);
    } else {
      await dumpMysql(databaseUrl, sqlPath);
    }

    await gzipFile(sqlPath, gzPath);
    unlinkSync(sqlPath);

    const client = buildR2Client();
    await uploadToR2(client, bucket, objectKey, gzPath);
    console.log("Upload complete.");

    await pruneOldBackups(client, bucket, `${prefix}/`, retentionDays);
    console.log("Done.");
  } finally {
    try {
      unlinkSync(sqlPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(gzPath);
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

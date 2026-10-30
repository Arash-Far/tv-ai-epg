#!/usr/bin/env node
/**
 * Step 4 of the grab: upload `epg/*.json` and `index/*.json` to the R2 bucket
 * the Worker reads (`[[r2_buckets]] binding = "EPG"` in wrangler.toml), over
 * R2's S3-compatible API.
 *
 * Usage: node epg/scripts/upload-r2.mjs <dir> [<dir> ...]
 *   Each <dir> is uploaded recursively with keys relative to it, so passing
 *   `epg/work/out` uploads `epg/<id>.json` and passing `epg/work` with an
 *   `index/` inside uploads `index/<CC>.json`.
 *
 * Env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *      R2_BUCKET (default tv-ai-epg)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: upload-r2.mjs <dir> [<dir> ...]");
  process.exit(2);
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET ?? "tv-ai-epg";
if (!account || !accessKeyId || !secretAccessKey) {
  console.error("CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
  process.exit(2);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${account}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
  // R2 now and then answers a transient 500 InternalError; the SDK default
  // (3 attempts, ~150 ms of backoff) gave up before it recovered.
  maxAttempts: 8,
  retryMode: "adaptive",
});

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else if (entry.name.endsWith(".json")) out.push({ full, key: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

let uploaded = 0;
for (const dir of dirs) {
  const files = await walk(dir);
  // A modest fan-out: R2 is happy with more, but the job is not in a hurry.
  const batch = 16;
  for (let i = 0; i < files.length; i += batch) {
    await Promise.all(files.slice(i, i + batch).map(async ({ full, key }) => {
      const Body = await fs.readFile(full);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body, ContentType: "application/json" }));
      uploaded++;
    }));
  }
}
console.log(`Uploaded ${uploaded} objects to ${bucket}`);

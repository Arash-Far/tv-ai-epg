#!/usr/bin/env node
/**
 * Step 1 of the grab: turn the Worker's wanted list into a custom.channels.xml
 * for iptv-org/epg, and build the matching index from every site's channel
 * list.
 *
 * Env:
 *   UPSTREAM_DIR   path to the iptv-org/epg checkout   (default: epg/upstream)
 *   WORK_DIR       where to write                      (default: epg/work)
 *   WORKER_URL     the Worker origin                   (default: https://tv-ai-proxy.tvai.workers.dev)
 *   ADMIN_SECRET   x-admin-secret for /v1/epg/wanted   (required unless WANTED_IDS is set)
 *   WANTED_IDS     comma-separated ids, for local runs without a Worker
 *
 * Writes:
 *   <WORK_DIR>/custom.channels.xml
 *   <WORK_DIR>/alternates.json   id → rows on other sites, for retry-missing.mjs
 *   <WORK_DIR>/index/<CC>.json, <WORK_DIR>/index/_global.json
 *   <WORK_DIR>/wanted.json   { ids, rows, missing }
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildIndex, groupByCountry, parseChannelsXML, renderChannelsXML, selectRows } from "./lib.mjs";

const upstream = process.env.UPSTREAM_DIR ?? path.resolve("epg/upstream");
const workDir = process.env.WORK_DIR ?? path.resolve("epg/work");
const workerURL = process.env.WORKER_URL ?? "https://tv-ai-proxy.tvai.workers.dev";

async function listChannelFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listChannelFiles(full)));
    else if (entry.name.endsWith(".channels.xml")) out.push(full);
  }
  return out;
}

async function fetchWanted() {
  if (process.env.WANTED_IDS !== undefined) {
    return process.env.WANTED_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error("ADMIN_SECRET (or WANTED_IDS) is required");
  const res = await fetch(`${workerURL}/v1/epg/wanted`, { headers: { "x-admin-secret": secret } });
  if (!res.ok) throw new Error(`/v1/epg/wanted → ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.ids) ? body.ids : [];
}

const files = await listChannelFiles(path.join(upstream, "sites"));
const channels = [];
for (const file of files) {
  channels.push(...parseChannelsXML(await fs.readFile(file, "utf8")));
}
console.log(`Read ${channels.length} channel rows from ${files.length} site files`);

// Index — always, so matching works before the first guide exists.
const index = buildIndex(channels);
const indexDir = path.join(workDir, "index");
await fs.mkdir(indexDir, { recursive: true });
const groups = groupByCountry(index);
for (const [cc, entries] of groups) {
  await fs.writeFile(path.join(indexDir, `${cc}.json`), JSON.stringify(entries));
}
await fs.writeFile(
  path.join(indexDir, "_global.json"),
  JSON.stringify([...index.values()].map((e) => ({ id: e.id, names: e.names })))
);
console.log(`Index: ${index.size} channels across ${groups.size} countries`);

// Wanted → rows.
const ids = await fetchWanted();
const { rows, alternates, missing } = selectRows(channels, ids);
await fs.writeFile(path.join(workDir, "custom.channels.xml"), renderChannelsXML(rows));
await fs.writeFile(path.join(workDir, "alternates.json"), JSON.stringify(alternates));
await fs.writeFile(path.join(workDir, "wanted.json"), JSON.stringify({ ids, rows: rows.length, missing }, null, 2));
console.log(`Wanted ${ids.length} ids → ${rows.length} grab rows` + (missing.length ? `; no grabber for: ${missing.join(", ")}` : ""));

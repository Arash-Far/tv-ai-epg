#!/usr/bin/env node
/**
 * Step 3 of the grab: split guide.xml into one JSON file per channel, plus a
 * `_meta.json` the Worker's /v1/epg/status reports.
 *
 * Usage: node epg/scripts/xmltv-to-json.mjs <out dir> <guide.xml> [<guide.xml> ...]
 *   Several guides (one per grab pass) merge; a channel's programmes come from
 *   whichever pass produced them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseXMLTV } from "./lib.mjs";

const [outDir, ...guidePaths] = process.argv.slice(2);
if (!outDir || !guidePaths.length) {
  console.error("usage: xmltv-to-json.mjs <out dir> <guide.xml> [<guide.xml> ...]");
  process.exit(2);
}

const epgDir = path.join(outDir, "epg");
await fs.mkdir(epgDir, { recursive: true });

const byChannel = new Map();
let found = 0;
for (const guidePath of guidePaths) {
  try {
    parseXMLTV(await fs.readFile(guidePath, "utf8"), byChannel);
    found++;
  } catch {
    // A pass that was skipped has no file; nothing to merge.
  }
}
if (!found) console.log("No guide files (nothing wanted this run) — writing meta only");
let programmes = 0;
for (const [id, list] of byChannel) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) continue;
  await fs.writeFile(path.join(epgDir, `${id}.json`), JSON.stringify(list));
  programmes += list.length;
}
const meta = { generatedAt: Math.floor(Date.now() / 1000), channels: byChannel.size, programmes };
await fs.writeFile(path.join(epgDir, "_meta.json"), JSON.stringify(meta));
console.log(`Wrote ${byChannel.size} channel files, ${programmes} programmes`);

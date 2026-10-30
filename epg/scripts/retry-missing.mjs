#!/usr/bin/env node
/**
 * Between grab passes: find the channels the last pass left empty and write a
 * channel list that tries each one on its next alternate site.
 *
 * Usage: node epg/scripts/retry-missing.mjs <work dir> <pass number>
 *   Reads  <work>/guide-<n>.xml for every pass so far, the list that pass <n>
 *          grabbed (custom.channels.xml for pass 1, pass-<n>.channels.xml
 *          after) and <work>/alternates.json.
 *   Writes <work>/pass-<n+1>.channels.xml (an empty <channels/> when nothing
 *          is left to retry — the workflow skips the grab then) and updates
 *          alternates.json.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { nextPassRows, parseChannelsXML, parseXMLTV, renderChannelsXML } from "./lib.mjs";

const [workDir, passArg] = process.argv.slice(2);
const pass = parseInt(passArg ?? "1", 10);
if (!workDir || !Number.isFinite(pass)) {
  console.error("usage: retry-missing.mjs <work dir> <pass number>");
  process.exit(2);
}

async function readOr(file, fallback) {
  try { return await fs.readFile(file, "utf8"); } catch { return fallback; }
}

const byChannel = new Map();
for (let i = 1; i <= pass; i++) {
  parseXMLTV(await readOr(path.join(workDir, `guide-${i}.xml`), ""), byChannel);
}
const lastList = pass === 1 ? "custom.channels.xml" : `pass-${pass}.channels.xml`;
const attempted = parseChannelsXML(await readOr(path.join(workDir, lastList), "")).map((r) => r.xmltv_id);
const alternates = JSON.parse(await readOr(path.join(workDir, "alternates.json"), "{}"));

const { rows, exhausted } = nextPassRows(attempted, byChannel, alternates);
await fs.writeFile(path.join(workDir, `pass-${pass + 1}.channels.xml`), renderChannelsXML(rows));
await fs.writeFile(path.join(workDir, "alternates.json"), JSON.stringify(alternates));
const empty = attempted.filter((id) => !(byChannel.get(id) ?? []).length);
console.log(`Pass ${pass}: ${attempted.length} tried, ${empty.length} empty → ${rows.length} to retry` +
  (exhausted.length ? `; no site left for: ${exhausted.join(", ")}` : ""));

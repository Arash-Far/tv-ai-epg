/**
 * Pure helpers shared by the grab-job scripts. Kept dependency-free and
 * side-effect-free so they are unit-testable with `node --test`.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the XML entities XMLTV uses (named + numeric). */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** `attrs('a="1" b=\'2\'')` → `{ a: "1", b: "2" }`. */
export function parseAttributes(text) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

/**
 * XMLTV time "20260918200000 +0200" → epoch seconds. A missing offset is
 * read as UTC. Returns null for anything unparseable.
 */
export function parseXMLTVTime(text) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(?:([+-])(\d{2})(\d{2}))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", sign, oh, om] = m;
  let epoch = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
  if (sign) {
    const offset = (+oh * 60 + +om) * 60;
    epoch += sign === "+" ? -offset : offset;
  }
  return epoch;
}

/** The country an iptv-org id belongs to: "France24French.fr@SD" → "FR". */
export function countryOfID(xmltvID) {
  const base = String(xmltvID ?? "").split("@")[0];
  const m = /\.([a-z]{2})$/i.exec(base);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Reads every `<channel …>name</channel>` of a *.channels.xml.
 * @returns {Array<{site: string, lang: string, xmltv_id: string, site_id: string, name: string}>}
 */
export function parseChannelsXML(xml) {
  const out = [];
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = parseAttributes(m[1]);
    out.push({
      site: a.site ?? "",
      lang: a.lang ?? "",
      xmltv_id: a.xmltv_id ?? "",
      site_id: a.site_id ?? "",
      name: decodeEntities(m[2]).trim(),
    });
  }
  return out;
}

/**
 * Whether a display name plausibly belongs to `id`. Site channel lists are
 * community-maintained and mislabel now and then ("TRT World HD" filed under
 * France24.fr); such a name would let an unrelated library channel match the
 * wrong guide. A name is kept when one of its 3+ letter words appears in the
 * id itself, or when it has no Latin words to judge by.
 */
export function nameBelongsToID(name, id) {
  const base = String(id ?? "").split("@")[0].replace(/\.[a-z]{2}$/i, "").toLowerCase();
  const words = String(name ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && /[a-z]/.test(w));
  if (!words.length) return true;
  return words.some((w) => base.includes(w));
}

/**
 * Builds the matching index from every site's channel list: one entry per
 * XMLTV id with every display name it goes by and the sites that carry it.
 * Feed variants ("RTL.de@SD") fold into their base id; names that do not
 * look like the id's are dropped (see `nameBelongsToID`), unless that would
 * leave the entry nameless.
 *
 * @param {Array<ReturnType<typeof parseChannelsXML>[number]>} channels
 * @returns {Map<string, {id: string, names: string[], sites: string[]}>}
 */
export function buildIndex(channels) {
  const index = new Map();
  for (const c of channels) {
    if (!c.xmltv_id) continue;
    const id = c.xmltv_id.split("@")[0];
    let entry = index.get(id);
    if (!entry) {
      entry = { id, names: [], sites: [] };
      index.set(id, entry);
    }
    if (c.name && !entry.names.includes(c.name)) entry.names.push(c.name);
    if (c.site && !entry.sites.includes(c.site)) entry.sites.push(c.site);
  }
  for (const entry of index.values()) {
    const kept = entry.names.filter((n) => nameBelongsToID(n, entry.id));
    if (kept.length) entry.names = kept;
  }
  return index;
}

/** Groups index entries by country for the per-country files. */
export function groupByCountry(index) {
  const groups = new Map();
  for (const entry of index.values()) {
    const cc = countryOfID(entry.id) ?? "_";
    if (!groups.has(cc)) groups.set(cc, []);
    groups.get(cc).push({ id: entry.id, names: entry.names });
  }
  return groups;
}

/**
 * Picks, for each wanted id, the `<channel>` row to grab it from first, and
 * the ordered alternates to fall back to when that site yields nothing (a
 * grabber breaks; tvtv.us 404'd on every US channel the day this shipped).
 * Sites are ordered by how many of the wanted channels they carry — bigger,
 * better-maintained grabbers first, and fewer distinct sites to hit.
 *
 * @returns {{ rows: Array<ReturnType<typeof parseChannelsXML>[number]>,
 *             alternates: Record<string, Array<ReturnType<typeof parseChannelsXML>[number]>>,
 *             missing: string[] }}
 */
export function selectRows(channels, wantedIDs) {
  const wanted = new Set(wantedIDs.map((id) => id.split("@")[0]));
  const bySite = new Map();
  for (const c of channels) {
    if (!c.xmltv_id) continue;
    const id = c.xmltv_id.split("@")[0];
    if (!wanted.has(id)) continue;
    if (!bySite.has(c.site)) bySite.set(c.site, new Map());
    // First row per site wins (a site may list the same id twice, e.g. SD/HD).
    if (!bySite.get(c.site).has(id)) bySite.get(c.site).set(id, c);
  }
  const siteOrder = [...bySite.entries()].sort((a, b) => b[1].size - a[1].size).map(([site]) => site);
  const rows = [];
  const alternates = {};
  const covered = new Set();
  for (const site of siteOrder) {
    for (const [id, row] of bySite.get(site)) {
      // Emit the base id so the guide file lands at epg/<id>.json.
      const emitted = { ...row, xmltv_id: id };
      if (covered.has(id)) {
        (alternates[id] ??= []).push(emitted);
        continue;
      }
      covered.add(id);
      rows.push(emitted);
    }
  }
  const missing = [...wanted].filter((id) => !covered.has(id)).sort();
  return { rows, alternates, missing };
}

/**
 * After a grab pass: which of `attempted` ids got no programmes, and the
 * next row to try for each. Consumes the head of `alternates` (mutated).
 *
 * @returns {{ rows: Array<object>, exhausted: string[] }} rows for the next
 *   pass, and ids with nothing left to try.
 */
export function nextPassRows(attempted, programmesByChannel, alternates) {
  const rows = [];
  const exhausted = [];
  for (const id of attempted) {
    if ((programmesByChannel.get(id) ?? []).length > 0) continue;
    const next = alternates[id]?.shift();
    if (next) rows.push(next);
    else exhausted.push(id);
  }
  return { rows, exhausted };
}

function escapeXML(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

/** Serialises rows back into a *.channels.xml the grabber accepts. */
export function renderChannelsXML(rows) {
  const lines = rows.map((r) =>
    `  <channel site="${escapeXML(r.site)}" lang="${escapeXML(r.lang)}" xmltv_id="${escapeXML(r.xmltv_id)}" site_id="${escapeXML(r.site_id)}">${escapeXML(r.name)}</channel>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${lines.join("\n")}\n</channels>\n`;
}

function firstTag(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeEntities(m[1]).trim() : null;
}

/**
 * Parses an XMLTV document into programmes grouped by channel id, in the
 * compact shape the Worker serves. Programmes without a usable start/stop
 * are dropped; a missing stop is filled from the next programme's start.
 *
 * @returns {Map<string, Array<{title: string, description?: string, category?: string, start: number, end: number}>>}
 */
export function parseXMLTV(xml, byChannel = new Map()) {
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = parseAttributes(m[1]);
    const start = parseXMLTVTime(a.start);
    const end = parseXMLTVTime(a.stop);
    const channel = a.channel;
    if (!channel || start === null) continue;
    const body = m[2];
    const title = firstTag(body, "title") ?? "";
    if (!title) continue;
    const item = { title, start, end };
    const description = firstTag(body, "desc");
    if (description) item.description = description;
    const category = firstTag(body, "category");
    if (category) item.category = category;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(item);
  }
  for (const [id, list] of byChannel) {
    list.sort((x, y) => x.start - y.start);
    // Merging passes can duplicate a programme; keep one per start time.
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i].start === list[i - 1].start) list.splice(i, 1);
    }
    const cleaned = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.end === null || p.end <= p.start) {
        const next = list[i + 1];
        if (!next) continue;
        p.end = next.start;
      }
      cleaned.push(p);
    }
    byChannel.set(id, cleaned);
  }
  return byChannel;
}

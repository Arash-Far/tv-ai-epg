import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex, countryOfID, decodeEntities, groupByCountry, nameBelongsToID, nextPassRows, parseChannelsXML,
  parseXMLTV, parseXMLTVTime, renderChannelsXML, selectRows,
} from "./lib.mjs";

test("parseXMLTVTime handles offsets and missing parts", () => {
  assert.equal(parseXMLTVTime("20260918200000 +0200"), Date.UTC(2026, 8, 18, 18, 0, 0) / 1000);
  assert.equal(parseXMLTVTime("20260918200000 -0500"), Date.UTC(2026, 8, 19, 1, 0, 0) / 1000);
  assert.equal(parseXMLTVTime("20260918200000"), Date.UTC(2026, 8, 18, 20, 0, 0) / 1000);
  assert.equal(parseXMLTVTime("20260918"), Date.UTC(2026, 8, 18) / 1000);
  assert.equal(parseXMLTVTime("garbage"), null);
});

test("decodeEntities covers named and numeric", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry &#233;t&#xE9; &quot;x&quot;"), 'Tom & Jerry été "x"');
});

test("parseChannelsXML + buildIndex fold feed variants and dedupe names", () => {
  const xml = `<?xml version="1.0"?><channels>
    <channel site="a.com" lang="fr" xmltv_id="TF1.fr" site_id="1">TF1</channel>
    <channel site="b.com" lang="fr" xmltv_id="TF1.fr@HD" site_id="2">TF1 HD</channel>
    <channel site="b.com" lang="fr" xmltv_id="TF1.fr" site_id="3">TF1</channel>
    <channel site="b.com" lang="fr" xmltv_id="" site_id="4">Unknown</channel>
    <channel site="c.com" lang="en" xmltv_id="BBCOne.uk" site_id="5">BBC One &amp; Co</channel>
  </channels>`;
  const rows = parseChannelsXML(xml);
  assert.equal(rows.length, 5);
  assert.equal(rows[4].name, "BBC One & Co");
  const index = buildIndex(rows);
  assert.deepEqual([...index.keys()].sort(), ["BBCOne.uk", "TF1.fr"]);
  assert.deepEqual(index.get("TF1.fr").names, ["TF1", "TF1 HD"]);
  assert.deepEqual(index.get("TF1.fr").sites, ["a.com", "b.com"]);
  const groups = groupByCountry(index);
  assert.deepEqual([...groups.keys()].sort(), ["FR", "UK"]);
  assert.equal(countryOfID("TF1.fr@HD"), "FR");
});

test("selectRows picks the site covering the most wanted channels", () => {
  const rows = parseChannelsXML(`<channels>
    <channel site="small.com" lang="fr" xmltv_id="TF1.fr" site_id="s1">TF1</channel>
    <channel site="big.com" lang="fr" xmltv_id="TF1.fr" site_id="b1">TF1</channel>
    <channel site="big.com" lang="fr" xmltv_id="France2.fr" site_id="b2">France 2</channel>
    <channel site="big.com" lang="fr" xmltv_id="France2.fr@HD" site_id="b2hd">France 2 HD</channel>
  </channels>`);
  const { rows: picked, alternates, missing } = selectRows(rows, ["TF1.fr", "France2.fr", "Nope.fr"]);
  assert.deepEqual(picked.map((r) => [r.xmltv_id, r.site, r.site_id]), [["TF1.fr", "big.com", "b1"], ["France2.fr", "big.com", "b2"]]);
  assert.deepEqual(missing, ["Nope.fr"]);
  assert.deepEqual(Object.keys(alternates), ["TF1.fr"]);
  assert.equal(alternates["TF1.fr"][0].site, "small.com");

  // big.com came back empty for TF1 → retry on small.com; France 2 is fine.
  const got = new Map([["France2.fr", [{ title: "x", start: 1, end: 2 }]]]);
  const next = nextPassRows(["TF1.fr", "France2.fr"], got, alternates);
  assert.deepEqual(next.rows.map((r) => [r.xmltv_id, r.site]), [["TF1.fr", "small.com"]]);
  assert.deepEqual(next.exhausted, []);
  // …and once small.com is also empty there is nothing left.
  const last = nextPassRows(["TF1.fr"], new Map(), alternates);
  assert.deepEqual(last.rows, []);
  assert.deepEqual(last.exhausted, ["TF1.fr"]);
  const xml = renderChannelsXML(picked);
  assert.ok(xml.includes('<channel site="big.com" lang="fr" xmltv_id="TF1.fr" site_id="b1">TF1</channel>'));
});

test("parseXMLTV groups, sorts, fills a missing stop and drops the last open one", () => {
  const xml = `<tv>
    <channel id="TF1.fr"><display-name>TF1</display-name></channel>
    <programme start="20260918210000 +0200" stop="20260918230000 +0200" channel="TF1.fr">
      <title lang="fr">Film</title><desc>Un film.</desc><category lang="fr">Cinéma</category>
    </programme>
    <programme start="20260918200000 +0200" channel="TF1.fr"><title>JT &amp; météo</title></programme>
    <programme start="20260918230000 +0200" channel="TF1.fr"><title>Open ended</title></programme>
    <programme start="bad" stop="x" channel="TF1.fr"><title>Broken</title></programme>
    <programme start="20260918200000 +0000" stop="20260918210000 +0000" channel="Other.uk"><title>Q</title></programme>
  </tv>`;
  const out = parseXMLTV(xml);
  const tf1 = out.get("TF1.fr");
  assert.deepEqual(tf1.map((p) => p.title), ["JT & météo", "Film"]);
  assert.equal(tf1[0].end, tf1[1].start);
  assert.equal(tf1[1].description, "Un film.");
  assert.equal(tf1[1].category, "Cinéma");
  assert.equal(tf1[0].description, undefined);
  assert.equal(out.get("Other.uk").length, 1);

  // A second pass merges into the same map without duplicating programmes.
  parseXMLTV(`<tv>
    <programme start="20260918200000 +0200" stop="20260918210000 +0200" channel="TF1.fr"><title>JT &amp; météo</title></programme>
    <programme start="20260919100000 +0000" stop="20260919110000 +0000" channel="New.fr"><title>N</title></programme>
  </tv>`, out);
  assert.deepEqual(out.get("TF1.fr").map((p) => p.title), ["JT & météo", "Film"]);
  assert.equal(out.get("New.fr").length, 1);
});

test("nameBelongsToID drops mislabelled names but keeps the entry usable", () => {
  assert.ok(nameBelongsToID("France 24 (Français)", "France24.fr"));
  assert.ok(nameBelongsToID("BFM TV", "BFMTV.fr"));
  assert.ok(nameBelongsToID("La Une", "LaUne.be"));
  assert.ok(!nameBelongsToID("TRT World HD", "France24.fr"));
  assert.ok(nameBelongsToID("قناة الجزيرة", "AlJazeera.qa"));
  const index = buildIndex(parseChannelsXML(`<channels>
    <channel site="a" lang="fr" xmltv_id="France24.fr" site_id="1">France 24</channel>
    <channel site="b" lang="fr" xmltv_id="France24.fr" site_id="2">TRT World HD</channel>
    <channel site="c" lang="xx" xmltv_id="Odd.xx" site_id="3">Nothing Alike</channel>
  </channels>`));
  assert.deepEqual(index.get("France24.fr").names, ["France 24"]);
  assert.deepEqual(index.get("Odd.xx").names, ["Nothing Alike"]);
});

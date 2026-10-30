# TV Guide data (EPG grab)

The app's TV Guide needs programme schedules the app itself has no source
for. This folder is the scheduled job that produces them, kept deliberately
small: it runs the open-source [iptv-org/epg](https://github.com/iptv-org/epg)
grabbers — which read each broadcaster's own published listings — only for
the channels users actually have, and drops the result where the Worker can
serve it.

```
 app ──POST /v1/epg/match──▶ Worker ──KV epgwant:<id>──┐
                                                       │  every 6 h
 GitHub Actions (this folder) ◀── GET /v1/epg/wanted ──┘
   │ build-channels.mjs   wanted ids → custom.channels.xml  +  index/<CC>.json
   │ iptv-org/epg grab    custom.channels.xml → guide.xml
   │ xmltv-to-json.mjs    guide.xml → epg/<id>.json + epg/_meta.json
   └ upload-r2.mjs        → R2 bucket `tv-ai-epg`
 app ──GET /v1/epg/schedule──▶ Worker ──R2 epg/<id>.json──▶ programmes
```

Demand-driven on purpose: the index (which channels exist, under which names)
is rebuilt every run so matching works from day one, but schedules are only
grabbed for ids somebody has matched in the last 30 days (`EPG_WANT_TTL_SECONDS`).
A freshly matched channel shows "Guide arriving soon" until the next run.

## One-time setup

1. Create the bucket: `cd cloudflare-worker && npx wrangler r2 bucket create tv-ai-epg`, then `wrangler deploy`.
2. In Cloudflare → R2 → *Manage R2 API tokens*, create a token with **Object
   Read & Write** on `tv-ai-epg`.
3. GitHub → repo *Settings → Secrets and variables → Actions*:
   - secrets `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - secret `TVAI_ADMIN_SECRET` (the Worker's `ADMIN_SECRET`)
   - optional variable `TVAI_WORKER_URL` (defaults to the production Worker)
4. Run the workflow once by hand (*Actions → EPG grab → Run workflow*) to seed
   the index; `GET /v1/epg/status` (admin) reports the last run.

## Running locally

```bash
git clone --depth 1 https://github.com/iptv-org/epg.git epg/upstream && (cd epg/upstream && npm install)
(cd epg && npm install)
WANTED_IDS="TF1.fr,BFMTV.fr" node epg/scripts/build-channels.mjs
(cd epg/upstream && npm run grab --- --channels=../work/custom.channels.xml --days=2 --output=../work/guide-1.xml)
node epg/scripts/retry-missing.mjs epg/work 1      # writes pass-2.channels.xml for the empty ones
node epg/scripts/xmltv-to-json.mjs epg/work/out epg/work/guide-1.xml
cd epg && npm test
```

`epg/work/` and `epg/upstream/` are gitignored.

## Notes

- Ids are iptv-org's (`France24.fr`, `BBCNews.uk`); the country is the suffix.
  Feed variants (`RTL.de@SD`) fold into their base id.
- When several sites carry a channel, the site carrying the most wanted
  channels is tried first (`selectRows`); channels that come back empty are
  retried on their next site, up to three passes (`retry-missing.mjs`). The
  first production run proved the need: tvtv.us covered every US channel and
  404'd on all of them; pass 2 recovered 37 of 45 via tvpassport.com.
- The Worker triggers this workflow itself the moment a match adds a new id
  (at most once per 15 min), so a fresh channel gets its guide in minutes.
  That needs the `GITHUB_TOKEN` Worker secret: a fine-grained PAT scoped to this repo only
  with *Actions: Read and write* (`wrangler secret put GITHUB_TOKEN`; the Worker's `EPG_DISPATCH_REPO` must point at this repo). Without
  it, the 6-hourly cron still covers everything.
- Site channel lists are community-maintained and occasionally mislabelled;
  `nameBelongsToID` drops display names that do not look like the id so a
  stray "TRT World" under `France24.fr` cannot pull the wrong library channel
  onto that guide.
- The upstream ref is pinned in the workflow. Bump it deliberately.

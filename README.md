# Ranked Tracker

Clash of Clans ranked-league standings with your own filters: weekly end-of-season
snapshots stored in Supabase, a Next.js site on Vercel for browsing them, and a
GitHub Actions cron doing the ingestion.

```
Supercell API ──► RoyaleAPI proxy ──► GitHub Actions cron ──► Supabase (Postgres)
                  (fixed IP)          (ingest + enrich)              │
                                                                     ▼
                                                        Next.js on Vercel (read-only)
```

## Why the proxy

Supercell binds every API key to a fixed IP address, and Vercel's serverless
functions get a different IP on every invocation — so a key can never be pinned
to them. Two ways around it, and the code supports both:

- **RoyaleAPI proxy (default).** Create the key whitelisted to `45.79.218.79`
  and leave `COC_API_BASE` at `https://cocproxy.royaleapi.dev/v1`. Free, no infra.
- **Your own fixed-IP host.** Whitelist that machine's IP and set
  `COC_API_BASE=https://api.clashofclans.com/v1`. Run the same scripts from cron
  there instead of GitHub Actions.

Either way the site itself never talks to Supercell — it only reads Supabase.

Ingestion runs on GitHub Actions rather than a Vercel cron for a second reason:
enrichment is roughly one API call per ranked player, which comfortably exceeds
any serverless function timeout.

## Setup

### 1. Supabase

Create a project, then run the files in `supabase/migrations/` in order
(SQL editor, or `supabase db push`). `0001_init.sql` creates the tables, the two
read views, and select-only RLS policies for `anon`; `0002_star_stats.sql` adds
the star columns and the function behind the offence/defence page;
`0003_explicit_weeks.sql` replaces that function with the version taking
explicit week lists. Run all three, in order.

### 2. API key

Sign up at [developer.clashofclans.com](https://developer.clashofclans.com),
verify the email, and create a key whitelisted to `45.79.218.79`.

### 3. Environment

```bash
cp .env.example .env          # worker
cp .env.example .env.local    # Next.js (only the NEXT_PUBLIC_* values are read)
npm install
```

Fill in `COC_API_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.

### 4. Discovery — do this before the first ingest

```bash
npm run discover
```

The public API docs don't cover the Ranked league revamp, so this asks the API
directly: it prints every league ID and name, checks which of them expose season
history, and dumps sample rows to `worker/discovery/`. Read the output, find the
tier you want (Legend II, etc.), and set `TRACKED_LEAGUE_IDS` in `.env`.

If a Legend tier turns out not to expose `/leagues/{id}/seasons`, the sample
dumps will show what it does expose — `ingest.ts` reads the ranking from one
endpoint in `ingestSeason()`, so pointing it elsewhere is a small change in one
function rather than a rewrite.

### 5. First ingest

```bash
npm run ingest -- --backfill 12   # last 12 seasons, if the API keeps that much
npm run enrich                    # Town Hall levels and clan countries
npm run dev
```

`ingest` is idempotent: a season already captured in full is skipped unless you
pass `--force`, so re-running it is cheap.

## Deploying

**Frontend (Vercel).** Import the repo, set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, deploy. Nothing else is needed — the service-role
key must *not* be set here.

**Ingestion (GitHub Actions).** In the repo settings add secrets `COC_API_TOKEN`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and variables `COC_API_BASE`,
`TRACKED_LEAGUE_IDS`. `.github/workflows/ingest.yml` then runs itself.

The ranked season resets Monday 13:00 AWST = **Monday 05:00 UTC**, so the workflow
fires at 05:30, 09:30 and 15:30 UTC on Mondays. The repeats cost almost nothing
(the ingest skips a season it already has) and cover Supercell publishing the
final standings late. You can also run it by hand from the Actions tab, with a
specific season or a backfill count.

## What you can do on the site

- **Rankings** — the standings table for a league and season, sortable on every
  numeric column, filterable by player name or tag, clan name or tag, country,
  Town Hall, and a trophy range. Rank movement is shown against the previous
  season.
- **Player page** — trophies and rank by season as separate charts (rank on an
  inverted axis, so up always means climbing), plus the underlying table.
- **Compare** — tick up to five players in the rankings table and overlay their
  season curves.
- **Offence vs defence** — average stars per attack over weeks *you* pick,
  plotted against average stars conceded per defence over a separate set of
  weeks you pick. The two selections are independent and neither has to be
  contiguous: 3, 10 and 17 August for offence against 24 August alone for
  defence is a normal selection, and so is skipping a week. Only players
  present in every selected week on both sides are included. Dot size is how
  many players share a coordinate (see the caveat below). Sortable table
  underneath with the gap between the two figures.

  The selection lives in the URL (`?off=2026-08-03,2026-08-24&def=2026-08-10`),
  so a particular comparison is a link you can bookmark or send to someone.
  Season ids that no longer exist are dropped and the page falls back to the
  default of the last three weeks against the latest.

## The star caveat — read this before trusting the offence/defence page

The ranking endpoints are documented to return `attackWins` and `defenseWins`,
which are win **counts**. An average like "2.69 stars per attack" needs a star
total and an attempt count, and a win count cannot produce one. Whether Ranked
mode exposes stars at all is undocumented.

So `worker/src/stars.ts` guesses: it probes a list of candidate field names on
each raw row and writes nulls when none match. `npm run ingest` prints which
names it matched on every run — watch for that line. If it says nothing matched,
open `worker/discovery/`, find the real field names, add them to the candidate
lists in that one file, and re-run `npm run ingest -- --force`. Nothing else in
the codebase needs to change.

Until then the offence/defence page says so plainly rather than showing an empty
chart or, worse, a plausible-looking wrong number.

A second thing worth knowing: everyone in a ranked week gets the same attack
allowance, so an average is always stars ÷ a fixed denominator. That means the
possible values are a limited set and thousands of players land on identical
coordinates. The scatter bins exact duplicates and scales each mark's area by
how many players it stands for — one dot per player would overprint and hide
the distribution entirely.

## Notes on the data

- Town Hall level and country don't come back from the ranking endpoints.
  TH comes from `/players/{tag}` and country from the player's clan via
  `/clans/{tag}`, both filled in by `npm run enrich`. Until it has run, those two
  columns are blank and their filters match nothing.
- Player name, clan and TH are stored **on each ranking row** as well as on the
  player record, so a player renaming or switching clans doesn't rewrite history.
- The offence/defence comparison runs as a Postgres function
  (`star_comparison`), not a client-side join — measured at 26ms over 24k
  ranking rows. It takes the two week lists as arrays, so changing the
  selection is one round trip, not a re-fetch of every week. The page ships the result as positional tuples rather than
  objects, which took the HTML for 8k players from 2.7MB to 596KB.
- The `snapshots.kind` column is `'final'` or `'interim'`. Everything today is
  `'final'`; if you later want mid-week captures, add a second cron calling
  ingest — the schema and both views already handle it, no migration needed.

## Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | the Next.js site |
| `npm run discover` | probe the API, dump league/season/shape info |
| `npm run ingest` | capture end-of-season standings |
| `npm run enrich` | fill in Town Hall levels and clan countries |
| `npm run typecheck` / `lint` | |

## Layout

```
src/app/          routes: /rankings, /player/[tag], /compare, /analysis
src/components/   filter bar, table, charts
src/lib/          Supabase client, typed queries
worker/src/       coc.ts (API client), discover, ingest, enrich,
                  stars.ts (the field-name shim to edit after discovery)
supabase/         migrations
```

Not affiliated with, endorsed by, or sponsored by Supercell.

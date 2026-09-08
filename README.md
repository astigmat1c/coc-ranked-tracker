# Ranked Tracker

Clash of Clans Legend II standings with your own filters: weekly snapshots built
by sweeping clans, stored in Supabase, browsed on a Next.js site, refreshed by a
GitHub Actions cron.

```
Supercell API ──► RoyaleAPI proxy ──► GitHub Actions cron ──► Supabase (Postgres)
                  (fixed IP)          (weekly clan sweep)            │
                                                                     ▼
                                                        Next.js on Vercel (read-only)
```

Population comes from clan member lists rather than any ranking endpoint,
because every ranking endpoint is either gone or capped in a way that makes it
useless for a tier. See **What the API actually exposes** below — it is the
most important section in this file.

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
a sweep is tens of thousands of API calls over twenty-odd minutes, which
comfortably exceeds any serverless function timeout.

## Setup

### 1. Supabase

Create a project, then run the files in `supabase/migrations/` in order
(SQL editor, or `supabase db push`). `0001_init.sql` creates the tables, the two
read views, and select-only RLS policies for `anon`; `0002_star_stats.sql` adds
the star columns and the function behind the offence/defence page;
`0003_explicit_weeks.sql` replaces that function with the version taking
explicit week lists; `0004_clan_sweep.sql` moves everything onto league tiers,
weekly deltas and the clan sweep; `0005_comparison_single_pass.sql` rewrites
the comparison function so it survives a real population;
`0006_capture_before_reset.sql` records how close to the weekly reset a
capture was taken. Run all six, in order.

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

This dumps the league tiers, leagues, locations and season lists to
`worker/discovery/`. The tier ids are already known — Legend II is
`105000035` — so this is a confirmation step rather than a discovery one, and
it is how you would notice if Supercell changed something.

### 5. First ingest

```bash
npm run sweep -- --discover   # builds the clan list, then captures this week
npm run dev
```

The first run is the slow one because it enumerates clans. After that,
`npm run sweep` reuses the stored clan list and takes about twenty minutes.

The comparison page needs **two** weekly snapshots before it shows anything —
its figures are the change between consecutive weeks, so a single capture has
nothing to compare against.

## Deploying

**Frontend (Vercel).** Import the repo, set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, deploy. Nothing else is needed — the service-role
key must *not* be set here.

**Ingestion (GitHub Actions).** In the repo settings add secrets `COC_API_TOKEN`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and variables `COC_API_BASE`,
`TRACKED_LEAGUE_IDS`. `.github/workflows/ingest.yml` then runs itself.

The ranked week, in UTC: counters zero at **Monday 05:00** and signup opens,
battles begin at **Monday 17:00** (Tuesday 01:00 AWST), and play runs right up
to the following Monday 05:00, when everything zeroes again. So the workflow
fires *before* the reset — 04:00 as insurance and 04:35 as the capture that
counts, as close to the end of play as a fifteen-minute sweep safely allows. A
capture taken after the reset records an empty week; see the findings section.
The sweep is idempotent per league-week, so a repeat just refreshes the same
snapshot. Clan rediscovery is
the expensive phase and runs only on the first Monday of the month. You can also
run it by hand from the Actions tab, with or without discovery.

## What you can do on the site

- **Rankings** — the standings table for a league and season, sortable on every
  numeric column, filterable by player name or tag, clan name or tag, country,
  Town Hall, and a trophy range. Rank movement is shown against the previous
  season.
- **Player page** — trophies and rank by season as separate charts (rank on an
  inverted axis, so up always means climbing), plus the underlying table.
- **Compare** — tick up to five players in the rankings table and overlay their
  season curves.
- **Offence vs defence** — attack wins per week over weeks *you* pick, plotted
  against defence wins per week over a separate set of weeks you pick. The two
  selections are independent and neither has to be contiguous: 3, 10 and 17
  August for offence against 24 August alone for defence is a normal selection,
  and so is skipping a week. Only players present in every selected week on both
  sides are included. Dot size is how many players share a coordinate. Sortable
  table underneath with the gap between the two figures.

  These are **wins, not stars** — see the findings section for why stars are not
  obtainable.

  The selection lives in the URL (`?off=2026-08-03,2026-08-24&def=2026-08-10`),
  so a particular comparison is a link you can bookmark or send to someone.
  Season ids that no longer exist are dropped and the page falls back to the
  default of the last three weeks against the latest.

## What the API actually exposes — findings

Supercell never documented the Ranked revamp, so this was established by
probing. It is worth reading before changing anything:

- **Legend II is a league *tier*, id `105000035`**, from `/leaguetiers`. It is
  not a league. `/leagues` still returns only the 23 legacy leagues, and every
  live row now reports the legacy league as `Unranked`, so `leagues` in this
  database is populated from `/leaguetiers` instead.
- **There is no ranking under a tier.** `/leaguetiers/{id}` returns a name and
  two icons. `/leaguetiers/{id}/seasons`, `/leaguetiers/{id}/rankings/players`,
  everything under `/leaguegroups/`, and every `/players/{tag}/…` sub-resource
  all 404.
- **`/locations/{id}/rankings/players` caps at exactly 200 and sorts by
  trophies.** In competitive countries the top 200 is entirely Legend I, so a
  full sweep of every country returned **zero** Legend II players for India,
  the US, Vietnam, Iran, Indonesia, Brazil, Russia, Germany, France, the UK,
  China and Japan. Its 3,277 rows came almost entirely from small countries.
  That route is unusable and is not what this project uses.
- **`/locations/32000006` ("International") is dead.** Only real countries
  respond.
- **Clan member rows carry `leagueTier` and `townHallLevel`.** One
  `/clans/{tag}` call classifies up to 50 players, clan search pages well past
  200, and measurement gave ~525 Legend II players per 1,000 clan calls. This
  is the route the sweep takes.
- **Stars are not served, but offence is recoverable.** No endpoint carries a
  star count. But a ranked battle splits a fixed **40 trophies**, and the
  attacker's share follows a fixed table — 0 stars pays 1 per full 10% damage
  (0–4), 1 star pays 5 plus 1 per full 9% above 1% (5–15), 2 stars pays 16 plus
  1 per full 3% above 50% (16–32), and 3 stars is a flat 40. The defender keeps
  the remainder. So a single battle's trophy movement *is* a star count. Poll
  often enough that a window holds one battle and the star falls out;
  `worker/src/classify.ts` reproduces a real logged week exactly — 30 attacks
  as 16/9/5/0 for 2.37.
  - Nothing can be worth **33–39**, which is load-bearing: an unattributed rise
    of 1–4 cannot be a defence (the attacker would need 36–39), so it must be
    the player's own failed 0-star attack, which `attackWins` does not count.
  - **Defence has a blind spot and it cannot be closed.** Being three-starred
    pays +0 and wins nothing, so no counter and no trophy moves and the battle
    is invisible — three of six in the logged week. Defence figures are
    incomplete in the direction that flatters the player, and `classify` says
    so rather than averaging the survivors.
  - Cadence is the other constraint. Attacks are bursty, and over 200 simulated
    weeks a 30-minute cadence resolves only 57% of events (star average off by
    0.11) against 70% at 15 minutes. Hence `--loop`, which polls from inside a
    scheduled run rather than relying on the scheduler.
- **Stars do not exist anywhere.** Not on the player record, not on a tier, not
  on any ranking or member row. Every response carries `attackWins` and
  `defenseWins` — win *counts*. An average like "2.69 stars per attack" cannot
  be computed from this API, so the comparison page runs on wins.

The player record is the one place the weekly ranked structure surfaces:
`leagueTier`, `currentLeagueGroupTag` (the ~100-player weekly pool) and
`currentLeagueSeasonId` / `previousLeagueSeasonId`, which are Unix seconds
exactly 604800 apart. None of those identifiers is queryable.

`npm run discover`, `npm run probe` and `npm run probe:clans` re-establish all
of the above against the live API, and will show it immediately if Supercell
opens any of it up.

## Notes on the data

- **Rank is derived.** A clan sweep has no global ranking, so `rank` is the
  player's position by trophies within the players the sweep actually captured.
  It is a rank within the tracked set, not a world rank.
- **Coverage is a large sample, not the whole tier.** The sweep sees players who
  are in a clan it reads, ordered by clan points so the most productive clans
  come first. A real run found 11,883 Legend-tier players in the top 1,000
  clans of 65,973 discovered. Raise `MAX_CLANS` for more, but the cost lands on
  the enrich pass, which is one API call per tracked player — `MAX_ENRICH` caps
  that so a big sweep cannot run away.
- **Everything that can return more than 1,000 rows pages.** PostgREST caps
  responses at 1,000 and does it silently: `.limit(20000)` returns 1,000 rows
  and no error. `selectPaged` in `worker/src/db.ts` exists for this, and it is
  not optional — the first live run swept 1,000 of 65,973 clans because of it.
  **This applies to functions too**: `performance_comparison` returned 1,000 of
  5,163 comparable players and drew a chart that looked entirely plausible.
  `getComparison` pages the RPC, and the function's `ORDER BY` ends in
  `player_tag` so the order is total — without a unique tiebreaker, ties come
  back in a different order on each execution and rows duplicate or vanish
  across page boundaries.
- **The comparison is one grouped pass, deliberately.** It used to build
  `offence`, `defence` and `latest` as separate CTEs and join them on
  `player_tag`. Postgres cannot estimate a CTE's row count, assumed one row,
  and chose a nested loop: 10.5 million comparisons to produce 4,600 rows from
  a 14,916-row table, which blew the statement timeout on the second week of
  real data. Offence and defence are now separated by `FILTER` on the
  aggregates instead, and the descriptive columns come from the same pass —
  2.7s to 34ms on that dataset, 3.9s to 133ms on a six-week one. Adding a join
  between CTEs here will quietly reintroduce it.
- **Snapshots are written with an explicit lookup, not an upsert.** The
  uniqueness rule is a partial index (`unique (league_id, season_id) where kind
  = 'final'`), and Postgres only infers a partial index for `ON CONFLICT` when
  the statement repeats the predicate — which PostgREST cannot express. The
  index still guards against concurrent double inserts.
- **A snapshot is only marked complete after its rows are counted back.** A
  partial week flagged complete would poison every delta computed against it.
- **A re-run clears the week before writing it.** Ranking rows are upserted on
  `(snapshot_id, player_tag)`, which inserts and updates but never removes, so a
  second attempt at the same week lands on top of the first — and the two
  populations are never identical, because a sweep of 5,000 clans sees a
  different set of players than one of 20,000. Survivors of the earlier attempt
  keep ranks assigned from a different field, leaving the week holding two
  interleaved rankings. The second live week hit exactly this: 9,709 rows
  present against 7,200 written. `clearSnapshotRows` empties the snapshot first,
  while it is still flagged incomplete, so whatever the run captures is exactly
  what the week holds.
- **`raw` on a ranking row is deliberately tiny.** A `/players/{tag}` response
  is ~40KB of troops, heroes, equipment and achievements; storing it per player
  per week is tens of megabytes a run and blew Supabase's statement timeout on
  the first attempt. Everything actually used has a typed column, so `raw`
  keeps only a few extra member fields.
- **Upserts halve and retry on a statement timeout.** How many rows fit inside
  the timeout depends on payload size and index count, which no fixed constant
  gets right — so a heavy batch slows down rather than failing the run.
- **A capture must happen before the reset.** `attackWins` and `defenseWins`
  are counters for the current ranked week and they zero at the Monday 05:00
  UTC boundary, along with trophies. A sweep at 11:47 UTC on a Monday found
  **9,752 of 9,753 players on zero attacks** — a whole week recorded as
  nothing. A mid-week sweep is no better: the Thursday capture before it holds
  three days of a seven-day week, 73% of players on zero. `snapshots.minutes_to_reset`
  records the distance to the boundary and the `weekly_snapshots` view keeps
  only captures taken within two hours of it; the sweep aborts outright if the
  week rolls over mid-run, since that would mix pre- and post-reset readings
  into one snapshot.
- **Weekly figures are deltas.** `attack_wins` is stored as reported; the
  per-week number is the change against the previous snapshot. If the counter
  resets at the weekly boundary the new value *is* the week's figure, and
  `player_week_stats` handles both cases, so it is correct either way.
- **The earliest snapshot has no delta** and therefore cannot be an offence or
  defence week. The comparison page excludes it from the picker rather than
  offering a choice that always returns nothing.
- Town Hall level and clan now arrive on the clan member row, so the old
  separate enrichment pass is gone. The extra `/players/{tag}` call is only for
  attack and defence wins.
- Player name, clan and TH are stored **on each ranking row** as well as the
  player record, so a rename or clan move never rewrites history.
- The comparison runs as a Postgres function (`performance_comparison`) taking
  two week lists as arrays, and the page ships results as positional tuples —
  2.7MB of HTML became 596KB at 8k players.

## Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | the Next.js site |
| `npm run sweep` | the weekly ingest: read clans, capture the week |
| `npm run watch` | poll a watchlist; `-- --loop 58 --every 120` to stay alive |
| `npm run classify -- --tags "#TAG"` | reconstruct battles and stars from polls |
| `npm run sweep -- --discover` | rebuild the clan list first (slow, monthly) |
| `npm run discover` | dump leagues, tiers, seasons, locations |
| `npm run probe -- --player "#TAG"` | re-test every ranked endpoint |
| `npm run probe:clans -- --clan "#TAG"` | re-test the clan route and its yield |
| `npm run survey` | measure the (unusable) country-sweep coverage |
| `npm run typecheck` / `lint` | |

## Layout

```
src/app/          routes: /rankings, /player/[tag], /compare, /analysis
src/components/   filter bar, table, charts
src/lib/          Supabase client, typed queries
worker/src/       coc.ts (API client), sweep.ts (the ingest),
                  discover / probe-ranked / probe-clans / survey (diagnostics)
supabase/         migrations
```

Not affiliated with, endorsed by, or sponsored by Supercell.

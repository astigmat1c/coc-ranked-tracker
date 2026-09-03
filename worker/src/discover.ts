/**
 * Discovery pass.
 *
 * The public API docs don't cover the Ranked league revamp, so rather than
 * guessing at league IDs and response shapes we ask the API directly and write
 * everything to worker/discovery/.
 *
 *   npm run discover
 *   npm run discover -- --player "#YOURTAG"    also dumps a full player record
 *
 * The player probe is worth doing: if the new Ranked tiers are exposed anywhere
 * in the API, a live player record is the most likely place, and it is the only
 * probe here that needs something from you.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cocFetch, CocApiError, encodeTag } from './coc.js';

const OUT = path.resolve(process.cwd(), 'worker/discovery');

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

async function dump(name: string, data: unknown) {
  await writeFile(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

/**
 * Probe an endpoint without letting a failure kill the run.
 *
 * The failure body is printed, not swallowed: the API answers with a JSON
 * `reason` that distinguishes "this endpoint is gone" from "your parameters
 * are wrong", and that distinction is the whole point of this script.
 */
async function probe<T>(label: string, path_: string, params = {}): Promise<T | null> {
  try {
    const data = await cocFetch<T>(path_, params);
    console.log(`  ok    ${path_}`);
    return data;
  } catch (err) {
    if (err instanceof CocApiError) {
      let reason = err.body.slice(0, 160).replace(/\s+/g, ' ');
      try {
        const parsed = JSON.parse(err.body) as { reason?: string; message?: string };
        reason = [parsed.reason, parsed.message].filter(Boolean).join(' — ') || reason;
      } catch { /* body wasn't JSON; the raw slice will do */ }
      console.log(`  ${String(err.status).padEnd(5)} ${path_}  (${label})  ${reason}`);
    } else {
      console.log(`  ???   ${path_}  (${label})  ${(err as Error).message}`);
    }
    return null;
  }
}

interface League { id: number; name: string }
interface Location { id: number; name: string; isCountry?: boolean; countryCode?: string }

/** Pages a cursor endpoint to exhaustion so we see the real newest entry. */
async function fetchAllSeasons(leagueId: number): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  for (let page = 0; page < 40; page++) {
    const res = await cocFetch<{
      items: { id: string }[];
      paging?: { cursors?: { after?: string } };
    }>(`/leagues/${leagueId}/seasons`, { limit: 100, after });

    ids.push(...(res.items ?? []).map((s) => s.id));
    after = res.paging?.cursors?.after;
    if (!after || !res.items?.length) break;
  }
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.COC_API_TOKEN) {
    throw new Error(
      'COC_API_TOKEN is not set. Copy .env.example to .env, then create a key at ' +
        'https://developer.clashofclans.com whitelisted to 45.79.218.79 (RoyaleAPI proxy).',
    );
  }

  await mkdir(OUT, { recursive: true });
  console.log(`Probing ${process.env.COC_API_BASE ?? 'the RoyaleAPI CoC proxy'}...\n`);

  // ---------------------------------------------------------------- leagues
  const leagues = await probe<{ items: League[] }>('league list', '/leagues', { limit: 200 });
  if (leagues) {
    await dump('leagues', leagues);
    console.log(`\n${leagues.items.length} leagues:`);
    for (const l of leagues.items) console.log(`  ${String(l.id).padEnd(10)} ${l.name}`);

    const ranked = leagues.items.filter((l) => /legend|ranked/i.test(l.name));
    console.log(
      `\n  → ${ranked.length} league(s) matching legend/ranked: ` +
        (ranked.map((l) => `${l.name} (${l.id})`).join(', ') || 'none'),
    );
  }

  // Other league families, in case ranked tiers live on their own endpoint.
  for (const p of ['/warleagues', '/capitalleagues', '/builderbaseleagues']) {
    const data = await probe<{ items: League[] }>('alt league list', p, { limit: 200 });
    if (data) await dump(`leaguelist${p.replace(/\//g, '_')}`, data);
  }

  // Speculative: endpoints that would exist if Ranked were exposed at all.
  console.log('\nSpeculative ranked endpoints (404 here is expected and fine):');
  for (const p of [
    '/rankedleagues',
    '/ranked/leagues',
    '/ranked/seasons',
    '/leagues/ranked',
    '/goldpass/seasons/current',
  ]) {
    const data = await probe('speculative', p, { limit: 50 });
    if (data) await dump(`speculative${p.replace(/\//g, '_')}`, data);
  }

  // ---------------------------------------------------------------- seasons
  // Only leagues the list actually returned are worth asking about.
  const candidates = (leagues?.items ?? [])
    .filter((l) => /legend|ranked/i.test(l.name))
    .map((l) => l.id);

  const seasonIndex: Record<string, unknown> = {};

  for (const id of candidates) {
    let all: string[];
    try {
      all = await fetchAllSeasons(id);
    } catch (err) {
      console.log(`\nleague ${id}: season list failed — ${(err as Error).message}`);
      continue;
    }

    // The endpoint returns oldest-first. Sorting rather than trusting position
    // is what the previous version of this script got wrong: it read the last
    // entry of a 20-row page and probed a season from 2017.
    const sorted = [...all].sort();
    const newest = sorted.at(-1);
    seasonIndex[id] = { count: all.length, oldest: sorted[0], newest, all: sorted };

    console.log(
      `\nleague ${id}: ${all.length} seasons, oldest ${sorted[0]}, newest ${newest}`,
    );

    // Try the three most recent. If the API only serves recent seasons, this
    // finds the cut-off instead of failing on an ancient one.
    for (const season of sorted.slice(-3).reverse()) {
      const ranking = await probe<{ items: unknown[] }>(
        'season ranking',
        `/leagues/${id}/seasons/${encodeURIComponent(season)}`,
        { limit: 5 },
      );
      if (ranking) {
        await dump(`season_${id}_${season.replace(/[^\w-]/g, '_')}`, ranking);
        console.log(`\n  SAMPLE ROW for ${season} — these are the only fields available:`);
        console.log(JSON.stringify(ranking.items?.[0], null, 2));
        break;
      }
    }
  }
  await dump('seasons', seasonIndex);

  // -------------------------------------------------------------- locations
  const locations = await probe<{ items: Location[] }>('locations', '/locations', { limit: 500 });
  if (locations) {
    await dump('locations', locations);
    console.log(`\n${locations.items.length} locations`);

    // Global player rankings used to live at 32000006. If that is gone, a real
    // country is the next thing to try before concluding rankings are dead.
    const global = locations.items.find((l) => /^global$/i.test(l.name));
    const australia = locations.items.find((l) => /^australia$/i.test(l.name));

    console.log('\nRanking endpoints:');
    for (const loc of [global, australia].filter(Boolean) as Location[]) {
      for (const kind of ['players', 'clans']) {
        const data = await probe<{ items: unknown[] }>(
          `${loc.name} ${kind}`,
          `/locations/${loc.id}/rankings/${kind}`,
          { limit: 3 },
        );
        if (data) {
          await dump(`ranking_${loc.id}_${kind}`, data);
          if (kind === 'players') {
            console.log(`\n  SAMPLE ROW — ${loc.name} player ranking:`);
            console.log(JSON.stringify(data.items?.[0], null, 2));
          }
        }
      }
    }
  }

  // ----------------------------------------------------------------- player
  // The likeliest place new Ranked fields would surface.
  if (args.player) {
    console.log('\nPlayer record:');
    const player = await probe<Record<string, unknown>>(
      'player detail',
      `/players/${encodeTag(args.player)}`,
    );
    if (player) {
      await dump('player', player);
      console.log('  top-level keys:', Object.keys(player).join(', '));
      for (const key of ['league', 'legendStatistics', 'ranked', 'rankedLeague', 'builderBaseLeague']) {
        if (key in player) {
          console.log(`\n  ${key}:`);
          console.log(JSON.stringify(player[key], null, 2));
        }
      }
    }
  } else {
    console.log(
      '\nNo --player given. Re-run with `npm run discover -- --player "#YOURTAG"` to dump a ' +
        'full player record — that is where new Ranked fields would most likely appear.',
    );
  }

  console.log(`\nRaw responses written to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

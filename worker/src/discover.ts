/**
 * Discovery pass.
 *
 * The public API docs don't cover the Ranked league revamp, so rather than
 * guessing at league IDs and response shapes we ask the API directly and write
 * everything to worker/discovery/. Run this once, before the first ingest:
 *
 *   npm run discover
 *
 * It prints a summary and leaves raw JSON on disk so the schema and the
 * ingester can be shaped around what actually comes back.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cocFetch, CocApiError } from './coc.js';

const OUT = path.resolve(process.cwd(), 'worker/discovery');

async function dump(name: string, data: unknown) {
  await writeFile(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

/** Probe an endpoint without letting a 404 kill the run. */
async function probe<T>(label: string, path_: string, params = {}): Promise<T | null> {
  try {
    const data = await cocFetch<T>(path_, params);
    console.log(`  ok    ${path_}`);
    return data;
  } catch (err) {
    const status = err instanceof CocApiError ? err.status : '???';
    console.log(`  ${String(status).padEnd(5)} ${path_}  (${label})`);
    return null;
  }
}

interface League {
  id: number;
  name: string;
  iconUrls?: Record<string, string>;
}

async function main() {
  // Fail loudly here rather than letting every probe report a swallowed 401.
  if (!process.env.COC_API_TOKEN) {
    throw new Error(
      'COC_API_TOKEN is not set. Copy .env.example to .env, then create a key at ' +
        'https://developer.clashofclans.com whitelisted to 45.79.218.79 (RoyaleAPI proxy) ' +
        'or to your own host IP.',
    );
  }

  await mkdir(OUT, { recursive: true });
  console.log(`Probing ${process.env.COC_API_BASE ?? 'the RoyaleAPI CoC proxy'}...\n`);

  // 1. Every league the API knows about. This is what tells us whether the new
  //    Ranked tiers (Legend I/II/III) are exposed and what their IDs are.
  const leagues = await probe<{ items: League[] }>('league list', '/leagues', { limit: 200 });
  if (leagues) {
    await dump('leagues', leagues);
    console.log(`\n${leagues.items.length} leagues:`);
    for (const l of leagues.items) console.log(`  ${String(l.id).padEnd(10)} ${l.name}`);
  }

  // 2. Some deployments expose ranked tiers on a separate endpoint.
  for (const p of ['/leagues', '/warleagues', '/capitalleagues', '/builderbaseleagues']) {
    const data = await probe<{ items: League[] }>('alt league list', p, { limit: 200 });
    if (data) await dump(`leaguelist${p.replace(/\//g, '_')}`, data);
  }

  // 3. Season history. Historically only Legend League (29000022) supported
  //    /seasons; we check that plus anything whose name mentions Legend, plus
  //    the ID pattern ClashSpot uses in its URLs.
  const candidates = new Set<number>([29000022, 105000035]);
  for (const l of leagues?.items ?? []) {
    if (/legend/i.test(l.name)) candidates.add(l.id);
  }

  const seasonIndex: Record<string, unknown> = {};
  for (const id of candidates) {
    const seasons = await probe<{ items: { id: string }[] }>(
      'season list',
      `/leagues/${id}/seasons`,
      { limit: 20 },
    );
    if (!seasons) continue;

    seasonIndex[id] = seasons;
    const latest = seasons.items?.at(-1)?.id ?? seasons.items?.[0]?.id;
    console.log(`\nleague ${id}: ${seasons.items?.length ?? 0} seasons, latest = ${latest}`);

    if (latest) {
      // One page is enough to learn the row shape.
      const ranking = await probe(
        'season ranking',
        `/leagues/${id}/seasons/${encodeURIComponent(latest)}`,
        { limit: 5 },
      );
      if (ranking) {
        await dump(`season_${id}_${latest.replace(/[^\w-]/g, '_')}`, ranking);
        const sample = (ranking as { items?: unknown[] }).items?.[0];
        console.log('  sample row:', JSON.stringify(sample, null, 2));
      }
    }
  }
  await dump('seasons', seasonIndex);

  // 4. Locations, and the global live ranking (32000006 is "Global").
  const locations = await probe<{ items: unknown[] }>('locations', '/locations', { limit: 500 });
  if (locations) {
    await dump('locations', locations);
    console.log(`\n${locations.items.length} locations`);
  }

  const globalRanking = await probe(
    'global player ranking',
    '/locations/32000006/rankings/players',
    { limit: 5 },
  );
  if (globalRanking) {
    await dump('global_player_ranking', globalRanking);
    console.log('\nglobal ranking sample row:');
    console.log(JSON.stringify((globalRanking as { items?: unknown[] }).items?.[0], null, 2));
  }

  console.log(`\nRaw responses written to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Ranked endpoint probe.
 *
 *   npm run probe -- --player "#9C8GQ92UG"
 *
 * The player record turned out to carry the whole map:
 *
 *   leagueTier:             { id: 105000035, name: "Legend II" }
 *   currentLeagueGroupTag:  "#8RP0YVG"      the ~100-player weekly pool
 *   currentLeagueSeasonId:  1788152400      unix seconds, Monday 05:00 UTC
 *   previousLeagueSeasonId: 1787547600      exactly 604800s earlier
 *
 * So the weekly Ranked structure is real and addressable. What we don't know is
 * the URL shape, and Supercell hasn't documented it. This script reads those
 * values from your own record and then tries every plausible path built from
 * them, printing the status and the API's own reason for each.
 *
 * A 404 means "no such endpoint". A 400 means the endpoint exists but disliked
 * the parameter — which is a hit worth chasing, not a miss.
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

const hits: { path: string; keys: string[]; count: number | null }[] = [];

async function probe(path_: string, params: Record<string, string | number> = {}) {
  try {
    const data = await cocFetch<Record<string, unknown>>(path_, params);

    const items = Array.isArray((data as { items?: unknown[] }).items)
      ? (data as { items: unknown[] }).items
      : null;
    const keys = Object.keys(data ?? {});

    console.log(`  \x1b[32mHIT\x1b[0m   ${path_}`);
    console.log(`        keys: ${keys.join(', ')}${items ? `  (${items.length} items)` : ''}`);

    hits.push({ path: path_, keys, count: items?.length ?? null });
    await writeFile(
      path.join(OUT, `hit_${path_.replace(/[^\w]+/g, '_').slice(0, 80)}.json`),
      JSON.stringify(data, null, 2),
    );
    return data;
  } catch (err) {
    if (err instanceof CocApiError) {
      let reason = '';
      try {
        const p = JSON.parse(err.body) as { reason?: string; message?: string };
        reason = [p.reason, p.message].filter(Boolean).join(' — ');
      } catch { reason = err.body.slice(0, 90).replace(/\s+/g, ' '); }
      // 400 is louder than 404: the route matched, the argument didn't.
      const mark = err.status === 400 ? '\x1b[33m400\x1b[0m' : String(err.status);
      console.log(`  ${mark}   ${path_}  ${reason}`);
    } else {
      console.log(`  ???   ${path_}  ${(err as Error).message}`);
    }
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tag = args.player;

  if (!process.env.COC_API_TOKEN) throw new Error('COC_API_TOKEN is not set.');
  if (!tag) {
    throw new Error('Pass your player tag:  npm run probe -- --player "#YOURTAG"');
  }

  await mkdir(OUT, { recursive: true });

  console.log('Reading your player record for the ranked identifiers...\n');
  const player = await cocFetch<{
    leagueTier?: { id: number; name: string };
    currentLeagueGroupTag?: string;
    previousLeagueGroupTag?: string;
    currentLeagueSeasonId?: number;
    previousLeagueSeasonId?: number;
  }>(`/players/${encodeTag(tag)}`);

  const tierId = player.leagueTier?.id;
  const groups = [player.currentLeagueGroupTag, player.previousLeagueGroupTag].filter(
    Boolean,
  ) as string[];
  const seasons = [player.currentLeagueSeasonId, player.previousLeagueSeasonId].filter(
    Boolean,
  ) as number[];

  console.log(`  leagueTier : ${tierId} (${player.leagueTier?.name ?? '?'})`);
  console.log(`  groups     : ${groups.join(', ') || 'none'}`);
  console.log(
    `  seasons    : ${seasons
      .map((s) => `${s} = ${new Date(s * 1000).toISOString()}`)
      .join('\n               ')}`,
  );

  // ------------------------------------------------------------------ tiers
  console.log('\n── League tier endpoints ' + '─'.repeat(40));
  await probe('/leaguetiers', { limit: 200 });
  await probe('/leaguetier', { limit: 200 });
  if (tierId) {
    await probe(`/leaguetiers/${tierId}`);
    await probe(`/leaguetiers/${tierId}/seasons`, { limit: 50 });
    await probe(`/leaguetiers/${tierId}/rankings/players`, { limit: 5 });
    await probe(`/leagues/${tierId}`);
    await probe(`/leagues/${tierId}/rankings/players`, { limit: 5 });
    for (const s of seasons) {
      await probe(`/leaguetiers/${tierId}/seasons/${s}`, { limit: 5 });
      await probe(`/leagues/${tierId}/seasons/${s}`, { limit: 5 });
    }
  }

  // ----------------------------------------------------------------- groups
  console.log('\n── League group endpoints ' + '─'.repeat(39));
  for (const g of groups) {
    await probe(`/leaguegroups/${encodeTag(g)}`);
    await probe(`/leaguegroup/${encodeTag(g)}`);
    await probe(`/rankedgroups/${encodeTag(g)}`);
    for (const s of seasons) {
      await probe(`/leaguegroups/${encodeTag(g)}/seasons/${s}`, { limit: 5 });
    }
  }

  // -------------------------------------------------------- player subpaths
  console.log('\n── Player sub-resources ' + '─'.repeat(41));
  const p = encodeTag(tag);
  for (const sub of [
    'leaguegroup',
    'currentleaguegroup',
    'rankedseason',
    'rankedseasons',
    'seasons',
    'leaguetier',
  ]) {
    await probe(`/players/${p}/${sub}`);
  }

  // ------------------------------------------------- legacy legend seasons
  // Confirms whether the classic Legend League ranking still serves data for
  // its newest season ids, which is the fallback if nothing above works.
  console.log('\n── Legacy Legend League seasons ' + '─'.repeat(33));
  const legacy = await cocFetch<{ items: { id: string }[] }>('/leagues/29000022/seasons', {
    limit: 100,
  }).catch(() => null);

  const newest = [...(legacy?.items ?? []).map((s) => s.id)].sort().slice(-3).reverse();
  for (const s of newest) {
    await probe(`/leagues/29000022/seasons/${encodeURIComponent(s)}`, { limit: 5 });
  }
  for (const s of seasons) {
    await probe(`/leagues/29000022/seasons/${s}`, { limit: 5 });
  }

  // ------------------------------------------------------ location rankings
  // The earlier run looked for a location named "Global"; it is called
  // "International", so this never actually got tested.
  console.log('\n── Location rankings ' + '─'.repeat(44));
  for (const [id, name] of [
    [32000006, 'International'],
    [32000021, 'Australia (country)'],
    [32000249, 'United States'],
  ] as [number, string][]) {
    console.log(`  · ${name}`);
    await probe(`/locations/${id}/rankings/players`, { limit: 3 });
    await probe(`/locations/${id}/rankings/players-ranked`, { limit: 3 });
  }

  // ---------------------------------------------------------------- summary
  console.log('\n' + '='.repeat(64));
  if (hits.length === 0) {
    console.log('No endpoint responded. The ranked structure is visible on the player');
    console.log('record but not queryable — a watchlist of player tags is the only route.');
  } else {
    console.log(`${hits.length} endpoint(s) responded:\n`);
    for (const h of hits) {
      console.log(`  ${h.path}`);
      console.log(`    keys: ${h.keys.join(', ')}${h.count !== null ? ` (${h.count} items)` : ''}`);
    }
    console.log(`\nFull responses saved as hit_*.json in ${OUT}`);
  }
  console.log('='.repeat(64));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

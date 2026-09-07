/**
 * Hunt for ranked star data in the live API.
 *
 *   npm run probe:stars -- --player "#YOURTAG" --expect 30,82,29,65,22,8,12,13,3
 *
 * The in-game Ranked screen shows attacks, total stars and an average
 * (30 attacks / 82 stars / 2.73) and the same for defences. This project
 * currently has only attackWins and defenseWins — win counts, not stars — and
 * an earlier probe concluded stars were not exposed anywhere. That probe
 * searched by endpoint. This one searches by VALUE: it walks every response it
 * can reach and reports the JSON path of anything matching a number you can
 * read off your own Ranked screen.
 *
 * That inverts the problem. If 82 appears anywhere in any reachable response,
 * this finds it and names the field, whatever the field happens to be called.
 * If it appears nowhere, that is real evidence rather than an assumption — run
 * it while your Ranked screen is open so the expected numbers are current.
 *
 * Nothing is written to the database. Responses land in worker/discovery/.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cocFetch, encodeTag, CocApiError } from './coc.js';

const OUT = join(process.cwd(), 'worker', 'discovery');

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[argv[i].slice(2)] = next;
      i++;
    }
  }
  return args;
}

/** Every leaf in a JSON tree, with the path that reaches it. */
function* leaves(value: unknown, path = '$'): Generator<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* leaves(value[i], `${path}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* leaves(v, `${path}.${k}`);
  } else {
    yield { path, value };
  }
}

/**
 * Report where the numbers you gave appear.
 *
 * Averages are matched with a tolerance because 2.73 on screen is a rounded
 * 82/30 = 2.7333…, and a raw field holding the unrounded value would otherwise
 * be missed.
 */
function findNumbers(body: unknown, wanted: number[], label: string) {
  const hits: string[] = [];

  for (const { path, value } of leaves(body)) {
    if (typeof value !== 'number') continue;
    for (const w of wanted) {
      const match = Number.isInteger(w) ? value === w : Math.abs(value - w) < 0.011;
      if (match) hits.push(`    ${w} at ${path}`);
    }
  }

  if (hits.length) {
    console.log(`  MATCHES in ${label}:`);
    for (const h of [...new Set(hits)]) console.log(h);
  }
  return hits.length;
}

/** Season ids are Unix seconds on a Monday 05:00 UTC boundary; 0 means unplaced. */
function stamp(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return `${v} (unset — not placed in a season yet)`;
  return `${n} = ${new Date(n * 1000).toISOString().replace('.000Z', 'Z')}`;
}

interface PlayerRecord {
  tag: string;
  name: string;
  attackWins?: number;
  defenseWins?: number;
  trophies?: number;
  leagueTier?: { id: number; name: string };
  clan?: { tag: string };
  currentLeagueGroupTag?: string;
  previousLeagueGroupTag?: string;
  currentLeagueSeasonId?: number | string;
  previousLeagueSeasonId?: number | string;
  league?: unknown;
  playerHouse?: unknown;
  [k: string]: unknown;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tag = args.player;

  if (!tag) {
    console.error('Usage: npm run probe:stars -- --player "#YOURTAG" [--expect 30,82,29,65]');
    process.exit(1);
  }

  const wanted = (args.expect ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  mkdirSync(OUT, { recursive: true });

  console.log(`player: ${tag}`);
  if (wanted.length) console.log(`looking for: ${wanted.join(', ')}\n`);
  else console.log('no --expect given; will dump responses but cannot match values\n');

  // ---- 1. The player record, in full ------------------------------------
  const player = await cocFetch<PlayerRecord>(`/players/${encodeTag(tag)}`);
  writeFileSync(join(OUT, 'player_full.json'), JSON.stringify(player, null, 2));

  console.log('/players/{tag} — full record written to worker/discovery/player_full.json');
  console.log(`  name ${player.name}, trophies ${player.trophies}`);
  console.log(`  attackWins ${player.attackWins}, defenseWins ${player.defenseWins}`);
  console.log(`  leagueTier ${player.leagueTier?.id} (${player.leagueTier?.name})`);
  console.log(`  currentLeagueGroupTag   ${player.currentLeagueGroupTag ?? '—'}`);
  console.log(`  previousLeagueGroupTag  ${player.previousLeagueGroupTag ?? '—'}`);
  console.log(`  currentLeagueSeasonId   ${stamp(player.currentLeagueSeasonId)}`);
  console.log(`  previousLeagueSeasonId  ${stamp(player.previousLeagueSeasonId)}`);
  console.log(`  league        ${JSON.stringify(player.league ?? null)}`);
  console.log(`  playerHouse   ${player.playerHouse ? 'present' : '—'}`);

  // Every top-level key, so a newly added field cannot hide.
  console.log(`  top-level keys: ${Object.keys(player).sort().join(', ')}`);
  const inPlayer = findNumbers(player, wanted, '/players/{tag}');
  if (!inPlayer && wanted.length) console.log('  (none of the expected numbers appear)');

  // ---- 2. Candidate endpoints -------------------------------------------
  //
  // Built from the player's own identifiers rather than guessed names alone.
  // The group tag is the ~100-player weekly pool the Ranked screen scores
  // against, so if a per-attack breakdown exists anywhere it is likeliest to
  // hang off that.
  // Both group tags, not just the current one.
  //
  // Straight after the Monday 05:00 UTC reset a player has no current group —
  // currentLeagueGroupTag is absent and currentLeagueSeasonId is 0 until they
  // attack. previousLeagueGroupTag is the pool they just finished, which is
  // precisely the week the Ranked results screen is showing. The first version
  // of this probe only looked at the current tag, so on a Monday it skipped
  // every group endpoint without saying so.
  const groups = [player.currentLeagueGroupTag, player.previousLeagueGroupTag].filter(
    (g): g is string => typeof g === 'string' && g.length > 0,
  );
  const season = player.currentLeagueSeasonId;
  const prevSeason = player.previousLeagueSeasonId;
  const tier = player.leagueTier?.id;
  const p = encodeTag(tag);

  const candidates: string[] = [
    `/players/${p}/legendleague`,
    `/players/${p}/legendstatistics`,
    `/players/${p}/rankedattacks`,
    `/players/${p}/attacks`,
    `/players/${p}/defenses`,
    `/players/${p}/seasons`,
    `/players/${p}/leaguegroup`,
    `/players/${p}/currentleague`,
    `/players/${p}/rankedseason`,
    `/players/${p}/leagueseason`,
  ];

  // The group is the ~100-player weekly pool the Ranked screen scores against.
  // If a per-attack or per-star breakdown exists anywhere, it hangs off this —
  // by analogy with CWL, where /clanwarleagues/groups/{tag} leads to rounds,
  // war tags, and finally per-member attacks carrying stars.
  for (const group of groups) {
    const g = encodeTag(group);
    candidates.push(
      `/leaguegroups/${g}`,
      `/leaguegroups/${g}/rounds`,
      `/leaguegroups/${g}/rankings`,
      `/leaguegroups/${g}/rankings/players`,
      `/leaguegroups/${g}/members`,
      `/leaguegroups/${g}/players`,
      `/leaguegroups/${g}/wars`,
      `/rankedgroups/${g}`,
      `/leagues/groups/${g}`,
      `/clanwarleagues/groups/${g}`,
      `/players/${p}/leaguegroups/${g}`,
    );
  }

  for (const s of [season, prevSeason]) {
    if (!Number(s)) continue;
    candidates.push(`/leagueseasons/${s}`, `/leagueseasons/${s}/rankings/players`);
    if (tier) {
      candidates.push(
        `/leaguetiers/${tier}/seasons/${s}/rankings/players`,
        `/leaguetiers/${tier}/seasons/${s}`,
      );
    }
    candidates.push(`/players/${p}/leagueseasons/${s}`);
  }
  if (tier) {
    candidates.push(`/leaguetiers/${tier}/seasons`, `/leaguetiers/${tier}/rankings/players`);
  }

  if (!groups.length) {
    console.log(
      '\nNOTE: this player has neither a current nor a previous league group tag, so ' +
        'every group endpoint is being skipped. Re-run mid-week, after some ranked ' +
        'attacks, when currentLeagueGroupTag is populated.',
    );
  }

  console.log(`\nprobing ${candidates.length} candidate endpoints (${groups.length} group tag(s))\n`);

  const reachable: { path: string; hits: number }[] = [];

  for (const path of candidates) {
    try {
      const body = await cocFetch<unknown>(path);
      const name = path.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
      writeFileSync(join(OUT, `probe_${name}.json`), JSON.stringify(body, null, 2));
      console.log(`  200  ${path}`);
      const hits = findNumbers(body, wanted, path);
      reachable.push({ path, hits });
    } catch (err) {
      const status = err instanceof CocApiError ? err.status : '???';
      console.log(`  ${status}  ${path}`);
    }
  }

  // ---- 3. Verdict --------------------------------------------------------
  console.log('\n--- summary ---');
  if (!reachable.length) {
    console.log('Nothing beyond /players/{tag} responded.');
  } else {
    console.log(`${reachable.length} endpoint(s) responded:`);
    for (const r of reachable) {
      console.log(`  ${r.path} — ${r.hits ? `${r.hits} value match(es)` : 'no expected values'}`);
    }
  }

  const total = reachable.reduce((n, r) => n + r.hits, 0) + inPlayer;
  console.log(
    total
      ? `\n${total} match(es) found. The paths above name the fields that hold your Ranked numbers.`
      : '\nNo expected value appeared anywhere reachable. If the numbers on your Ranked ' +
          'screen are current, that is evidence the API does not expose them.',
  );
  console.log('Full responses are in worker/discovery/ — send them over.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

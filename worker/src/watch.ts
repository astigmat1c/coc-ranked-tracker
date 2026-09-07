/**
 * Poll a watchlist often enough to see individual battles.
 *
 *   npm run watch                            poll every tag in WATCH_TAGS once
 *   npm run watch -- --tags "#A,#B"          override the list
 *   npm run watch -- --loop 55 --every 120   poll every 2 min for 55 minutes
 *
 * One API call per player per poll. All players in a poll share one
 * captured_at, which makes the windows line up across the watchlist so an
 * analysis reasons about the same interval for everybody.
 *
 * Cadence decides how much of a week can be read at all. A window holding two
 * events cannot be split, and attacks are bursty — people spend their thirty in
 * a few sessions rather than evenly. Simulated over 200 weeks with seven
 * attacking sessions:
 *
 *   every 60 min   44% of events resolved, star average off by 0.23
 *   every 30 min   57%                                        0.11
 *   every 20 min   65%                                        0.09
 *   every 15 min   70%                                        0.07
 *
 * Good enough for a population, too coarse to check one player's screen
 * against. Hence --loop: a single scheduled run stays alive and polls every
 * couple of minutes, so an hourly job gives two-minute resolution for a small
 * watchlist at thirty calls an hour.
 */
import 'dotenv/config';
import { cocFetch, encodeTag, normaliseTag, mapLimit, CocApiError } from './coc.js';
import { getDb, upsertChunked } from './db.js';
import { seasonIdFor } from './sweep.js';

interface PlayerLite {
  tag: string;
  name: string;
  trophies?: number;
  attackWins?: number;
  defenseWins?: number;
  leagueTier?: { id: number };
}

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

export function tagList(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))].map(normaliseTag);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tags = tagList(args.tags ?? process.env.WATCH_TAGS);

  if (!tags.length) {
    throw new Error(
      'No players to watch. Set WATCH_TAGS to a comma-separated list of tags, ' +
        'or pass --tags "#AAA,#BBB".',
    );
  }

  // Fail on a bad environment before spending an hour polling into nothing.
  void getDb();

  const loopMinutes = Number(args.loop ?? process.env.WATCH_LOOP_MINUTES ?? 0);
  const everySeconds = Number(args.every ?? process.env.WATCH_EVERY_SECONDS ?? 120);

  if (!loopMinutes) {
    await pollOnce(tags);
    return;
  }

  const until = Date.now() + loopMinutes * 60_000;
  console.log(
    `polling ${tags.length} player(s) every ${everySeconds}s for ${loopMinutes} min ` +
      `(${Math.floor((loopMinutes * 60) / everySeconds)} polls)`,
  );

  while (Date.now() < until) {
    const started = Date.now();
    try {
      await pollOnce(tags);
    } catch (err) {
      // One failed poll is a gap in the series, which the analysis handles as a
      // longer window. Ending the run early would be a much bigger gap.
      console.error(`  poll failed: ${(err as Error).message}`);
    }
    const wait = everySeconds * 1000 - (Date.now() - started);
    if (wait > 0 && Date.now() + wait < until) await sleep(wait);
    else if (Date.now() + wait >= until) break;
  }
}

async function pollOnce(tags: string[]) {
  // One instant for the whole poll, so every player's series shares boundaries.
  const at = new Date();
  const seasonId = seasonIdFor(at);

  const rows: object[] = [];
  const missing: string[] = [];

  await mapLimit(
    tags,
    async (tag) => {
      try {
        const p = await cocFetch<PlayerLite>(`/players/${encodeTag(tag)}`);
        rows.push({
          player_tag: normaliseTag(p.tag),
          captured_at: at.toISOString(),
          season_id: seasonId,
          trophies: p.trophies ?? null,
          attack_count: p.attackWins ?? null,
          defence_count: p.defenseWins ?? null,
          league_tier_id: p.leagueTier?.id ?? null,
        });
      } catch (err) {
        // A missing player should not lose the rest of the run's observations —
        // a gap in one series is recoverable, a skipped poll for everyone is not.
        if (err instanceof CocApiError && err.status === 404) missing.push(tag);
        else throw err;
      }
    },
    10,
  );

  if (rows.length) await upsertChunked('player_polls', rows, 'player_tag,captured_at');

  console.log(
    `${at.toISOString()}  polled ${rows.length}/${tags.length} in season ${seasonId}` +
      (missing.length ? `  (not found: ${missing.join(', ')})` : ''),
  );

  // A one-line sample makes a scheduled run's log worth reading at a glance.
  const sample = rows[0] as
    | { player_tag: string; trophies: number; attack_count: number; defence_count: number }
    | undefined;
  if (sample) {
    console.log(
      `  ${sample.player_tag}: ${sample.trophies} trophies, ` +
        `${sample.attack_count} attacks, ${sample.defence_count} defences`,
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

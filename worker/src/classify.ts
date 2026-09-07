/**
 * Turn a series of polls into classified battles.
 *
 *   npm run classify -- --tags "#9C8GQ92UG"
 *   npm run classify -- --season 2026-09-07 --events
 *
 * Every battle splits a fixed 40 trophies between attacker and defender, and
 * the split is set by stars and destruction. So a window containing exactly one
 * event carries that event's star count in its trophy movement.
 *
 * The bands below come from observed play and are provisional — which is why
 * --events prints every raw value. If the awards really are banded this way the
 * printed values cluster and the bands can be tightened; if they are not, the
 * clustering fails visibly rather than producing confident nonsense.
 */
import 'dotenv/config';
import { getDb, selectPaged } from './db.js';

/**
 * Attacker's trophy gain -> stars.
 *
 * A 3-star is 40. A 2-star runs roughly 20–32 with destruction deciding where
 * in the band. Below that is a 1-star, and a 0-star earns nothing. The 33–39
 * gap is treated as a high 2-star rather than a low 3-star, since 40 was
 * described as the 3-star value exactly.
 */
export function starsFromAttackerGain(gain: number): 0 | 1 | 2 | 3 {
  if (gain >= 40) return 3;
  if (gain >= 20) return 2;
  if (gain >= 1) return 1;
  return 0;
}

/**
 * Defender's trophy gain -> stars conceded.
 *
 * The inverse, via the 40-trophy split: what the defender keeps is what the
 * attacker did not take. Holding at zero stars is the full 40; being
 * three-starred is nothing.
 */
export function starsConcededFromDefenderGain(gain: number): 0 | 1 | 2 | 3 {
  return starsFromAttackerGain(40 - gain);
}

export interface Poll {
  captured_at: string;
  season_id: string;
  trophies: number | null;
  attack_count: number | null;
  defence_count: number | null;
}

export type EventKind = 'attack' | 'defence';

export interface Battle {
  at: string;
  kind: EventKind;
  trophyDelta: number;
  stars: 0 | 1 | 2 | 3;
}

export interface Reconstruction {
  battles: Battle[];
  /** Windows holding more than one event; the trophy change cannot be split. */
  ambiguous: number;
  /** Events inside those windows, so coverage can be stated honestly. */
  ambiguousEvents: number;
  /** Trophies moved with no attack or defence to explain them. */
  unexplained: number;
  /** Windows spanning the weekly reset, skipped rather than read as a huge loss. */
  resets: number;
}

/**
 * Walk consecutive polls and resolve what happened between them.
 *
 * Only windows with exactly one event are classified. A window holding an
 * attack and a defence together cannot be split — the trophy change is the sum
 * of two unknowns — so it is counted, not guessed at. Reporting how many events
 * were lost that way is what makes the resulting average honest.
 */
export function reconstruct(polls: Poll[]): Reconstruction {
  const out: Reconstruction = {
    battles: [],
    ambiguous: 0,
    ambiguousEvents: 0,
    unexplained: 0,
    resets: 0,
  };

  for (let i = 1; i < polls.length; i++) {
    const prev = polls[i - 1];
    const cur = polls[i];

    if (
      prev.trophies == null || cur.trophies == null ||
      prev.attack_count == null || cur.attack_count == null ||
      prev.defence_count == null || cur.defence_count == null
    ) {
      continue;
    }

    // The weekly reset zeroes trophies and both counters. A window spanning it
    // has no meaning: the counters go backwards and the trophy change is the
    // reset, not a battle.
    if (
      cur.season_id !== prev.season_id ||
      cur.attack_count < prev.attack_count ||
      cur.defence_count < prev.defence_count
    ) {
      out.resets++;
      continue;
    }

    const da = cur.attack_count - prev.attack_count;
    const dd = cur.defence_count - prev.defence_count;
    const dt = cur.trophies - prev.trophies;

    if (da === 0 && dd === 0) {
      if (dt !== 0) out.unexplained++;
      continue;
    }

    if (da + dd > 1) {
      out.ambiguous++;
      out.ambiguousEvents += da + dd;
      continue;
    }

    if (da === 1) {
      out.battles.push({
        at: cur.captured_at,
        kind: 'attack',
        trophyDelta: dt,
        stars: starsFromAttackerGain(dt),
      });
    } else {
      out.battles.push({
        at: cur.captured_at,
        kind: 'defence',
        trophyDelta: dt,
        stars: starsConcededFromDefenderGain(dt),
      });
    }
  }

  return out;
}

export function summarise(battles: Battle[], kind: EventKind) {
  const of = battles.filter((b) => b.kind === kind);
  const hist = [0, 0, 0, 0];
  let stars = 0;
  for (const b of of) {
    hist[b.stars]++;
    stars += b.stars;
  }
  return {
    count: of.length,
    stars,
    average: of.length ? stars / of.length : 0,
    hist,
    deltas: of.map((b) => b.trophyDelta).sort((a, b) => b - a),
  };
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
  }
  return args;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tags = String(args.tags ?? process.env.WATCH_TAGS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const season = args.season ? String(args.season) : null;

  if (!tags.length) throw new Error('Pass --tags "#TAG" or set WATCH_TAGS.');

  for (const tag of tags) {
    const polls = await selectPaged<Poll>((from, to) => {
      let q = getDb()
        .from('player_polls')
        .select('captured_at, season_id, trophies, attack_count, defence_count')
        .eq('player_tag', tag);
      if (season) q = q.eq('season_id', season);
      return q.order('captured_at', { ascending: true }).range(from, to);
    });

    console.log(`\n=== ${tag}${season ? ` · ${season}` : ''} ===`);
    if (polls.length < 2) {
      console.log(`only ${polls.length} poll(s) stored — nothing to difference yet`);
      continue;
    }

    const first = polls[0].captured_at;
    const last = polls[polls.length - 1].captured_at;
    const hours = (Date.parse(last) - Date.parse(first)) / 3_600_000;
    console.log(
      `${polls.length} polls over ${hours.toFixed(1)}h ` +
        `(${(hours / Math.max(1, polls.length - 1) * 60).toFixed(0)} min apart on average)`,
    );

    const r = reconstruct(polls);
    const atk = summarise(r.battles, 'attack');
    const def = summarise(r.battles, 'defence');
    const total = atk.count + def.count + r.ambiguousEvents;

    console.log(
      `resolved ${atk.count + def.count} of ${total} events ` +
        `(${pct(atk.count + def.count, total)}); ` +
        `${r.ambiguous} ambiguous window(s) holding ${r.ambiguousEvents} event(s); ` +
        `${r.unexplained} unexplained trophy move(s); ${r.resets} reset boundary/ies`,
    );

    console.log(
      `\nATTACKS   ${atk.count} attacks, ${atk.stars} stars, avg ${atk.average.toFixed(2)}`,
    );
    console.log(
      `          3★ ${atk.hist[3]}   2★ ${atk.hist[2]}   1★ ${atk.hist[1]}   0★ ${atk.hist[0]}`,
    );
    console.log(
      `DEFENCES  ${def.count} defences, ${def.stars} stars conceded, avg ${def.average.toFixed(2)}`,
    );
    console.log(
      `          3★ ${def.hist[3]}   2★ ${def.hist[2]}   1★ ${def.hist[1]}   0★ ${def.hist[0]}`,
    );

    if (args.events) {
      console.log('\nraw attack gains :', atk.deltas.join(', '));
      console.log('raw defence gains:', def.deltas.join(', '));
      console.log('\nevery resolved battle:');
      for (const b of r.battles) {
        console.log(`  ${b.at}  ${b.kind.padEnd(8)} ${String(b.trophyDelta).padStart(4)}  ${b.stars}★`);
      }
    }
  }

  console.log(
    '\nCompare these against the in-game Ranked screen for the same week. If the ' +
      'attack histogram and average match, the classification is sound and it can ' +
      'be applied to everyone.',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * Turn a series of polls into classified battles.
 *
 *   npm run classify -- --tags "#Y0992RGYY"
 *   npm run classify -- --season 2026-09-07 --events
 *
 * WHAT THE COUNTERS ACTUALLY MEAN
 *
 * Established against a real battle log (VI, #Y0992RGYY, week of 7 September):
 * 30 attacks totalling +947, six defences totalling +30, 977 trophies — and
 * the API reporting attackWins 30, defenseWins 0.
 *
 *   attackWins   attacks WON, meaning one star or better. Not attacks used.
 *                All 30 of VI's attacks scored, so the two coincided for him;
 *                a 0-star attack would not increment it.
 *   defenseWins  defences WON, meaning the attacker took nothing. VI faced six
 *                defences and won none of them, hence 0. It is NOT a count of
 *                defences received, which was the original assumption and is
 *                wrong.
 *   trophies     a running total that only ever rises. Both attacking and
 *                defending add 0..40, so the sign of a change says nothing
 *                about which kind of battle caused it.
 *
 * HOW A BATTLE IS IDENTIFIED
 *
 * Every battle splits a fixed 40 between attacker and defender, and the
 * attacker's share follows a published award table:
 *
 *   0 stars   1 trophy per full 10% damage                 ->  0..4
 *   1 star    5 base, +1 per full 9% of damage above 1%    ->  5..15
 *   2 stars   16 base, +1 per full 3% of damage above 50%  -> 16..32
 *   3 stars   40 flat
 *
 * The defender keeps the remainder, so conceding three stars pays 0 and
 * holding at zero stars pays the full 40.
 *
 * Note what is missing: no attack can be worth 33 to 39. That gap is useful —
 * an unattributed trophy rise of 1..4 cannot be a defence, because that would
 * require the attacker to have taken 36..39, so it must be a failed 0-star
 * attack by this player.
 *
 * With attackWins rising by one, the window holds an attack and its trophy
 * change is that attack's award. With no counter moving but trophies rising,
 * nobody attacked — so the player was attacked, and what they kept is 40 minus
 * what the attacker took. That inference is corroborated by five watched
 * players sitting on 0 attacks and 0 defence wins with 21 to 75 trophies: they
 * had not attacked at all, so every trophy came from being attacked.
 *
 * THE BLIND SPOT, STATED PLAINLY
 *
 * A defence where the attacker three-stars you pays +0 and wins you nothing.
 * No counter moves and no trophy moves, so it is invisible — three of VI's six
 * defences were exactly this. Defence figures from polling are therefore
 * incomplete in a way that flatters the player, and the report says so rather
 * than presenting an average computed from the defences that happened to go
 * well. A 0-star attack is invisible for the same reason, though far rarer.
 *
 * Offence has no such hole: every attack that scores anything is seen.
 */
import 'dotenv/config';
import { getDb, selectPaged } from './db.js';

/** The most a single battle can move either player's total. */
export const BATTLE_TROPHIES = 40;

/**
 * Attacker's trophy gain -> stars scored, straight off the award table.
 *
 * The boundaries are 16 and 5, not 20 and 1. An earlier version guessed 20 and
 * 1 from observed values and was wrong at both ends: +16..+19 is a two-star on
 * exactly 50-59% damage, and +1..+4 is a zero-star that merely did some damage.
 * VI's battle log contains no value in either range, which is why it validated
 * anyway — a reminder that agreeing with one sample is not the same as being
 * right.
 */
export function starsFromAttackerGain(gain: number): 0 | 1 | 2 | 3 {
  if (gain >= 40) return 3;
  if (gain >= 16) return 2;
  if (gain >= 5) return 1;
  return 0;
}

/**
 * Whether an attacker could have been awarded this many trophies at all.
 *
 * Two stars tops out at 32 and three stars is a flat 40, so 33..39 is
 * unreachable. A value in that gap means the reading is not a single attack.
 */
export function attackerGainIsPossible(gain: number): boolean {
  return gain >= 0 && gain <= 32 || gain === BATTLE_TROPHIES;
}

/** Defender's trophy gain -> stars conceded, via the 40-trophy split. */
export function starsConcededFromDefenderGain(gain: number): 0 | 1 | 2 | 3 {
  return starsFromAttackerGain(BATTLE_TROPHIES - gain);
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
  /** Trophies this player gained from it. */
  trophyDelta: number;
  /** Attack: stars scored. Defence: stars conceded. */
  stars: 0 | 1 | 2 | 3;
}

export interface Reconstruction {
  battles: Battle[];
  /** Windows whose trophy change cannot be attributed to one battle. */
  ambiguous: number;
  ambiguousEvents: number;
  /** Windows spanning the weekly reset. */
  resets: number;
  /** Windows whose trophy change no single battle could have produced. */
  impossible: number;

  // ---- audit ----
  /** How far attackWins moved: attacks that scored at least one star. */
  attackWinsSeen: number;
  /** How far defenseWins moved: defences where the attacker took nothing. */
  defenceWinsSeen: number;
  trophyMovement: number;
  trophyResolved: number;
}

/**
 * Walk consecutive polls and resolve what happened between them.
 *
 * A window is only classified when one battle can explain it. Since a single
 * battle can move a player by at most 40, a larger change means two or more
 * battles landed together and the trophies cannot be split between them — such
 * a window is counted, never guessed at.
 */
export function reconstruct(polls: Poll[]): Reconstruction {
  const out: Reconstruction = {
    battles: [],
    ambiguous: 0,
    ambiguousEvents: 0,
    resets: 0,
    impossible: 0,
    attackWinsSeen: 0,
    defenceWinsSeen: 0,
    trophyMovement: 0,
    trophyResolved: 0,
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

    // The reset zeroes trophies and both counters, so a window spanning it
    // describes the reset rather than a battle.
    if (
      cur.season_id !== prev.season_id ||
      cur.attack_count < prev.attack_count ||
      cur.defence_count < prev.defence_count ||
      cur.trophies < prev.trophies
    ) {
      out.resets++;
      continue;
    }

    const da = cur.attack_count - prev.attack_count;
    const dd = cur.defence_count - prev.defence_count;
    const dt = cur.trophies - prev.trophies;

    out.attackWinsSeen += da;
    out.defenceWinsSeen += dd;
    out.trophyMovement += dt;

    // Nothing observable happened. Note this is also what a three-starred
    // defence and a zero-star attack look like — see the blind spot above.
    if (da === 0 && dd === 0 && dt === 0) continue;

    // Two counters moving, or more trophies than one battle can award, means
    // several battles shared the window.
    if (da + dd > 1 || dt > BATTLE_TROPHIES) {
      out.ambiguous++;
      out.ambiguousEvents += Math.max(da + dd, Math.ceil(dt / BATTLE_TROPHIES));
      continue;
    }

    if (da === 1) {
      // An attack that scored at least one star. Its award is the whole change.
      if (!attackerGainIsPossible(dt)) {
        out.impossible++;
        continue;
      }
      out.trophyResolved += dt;
      out.battles.push({
        at: cur.captured_at,
        kind: 'attack',
        trophyDelta: dt,
        stars: starsFromAttackerGain(dt),
      });
      continue;
    }

    // No attack counter movement. Either the player was attacked, or they
    // attacked and scored nothing — attackWins only counts attacks that scored.
    // The award table separates the two: a defence pays the attacker's
    // remainder, and 33..39 is not a payable amount, so 1..4 to this player
    // could only have come from their own failed attack.
    if (dt >= 1 && dt <= 4) {
      out.trophyResolved += dt;
      out.battles.push({ at: cur.captured_at, kind: 'attack', trophyDelta: dt, stars: 0 });
      continue;
    }

    // 5..7 is unreachable from either side: as an attack it would be a one-star
    // and would have moved attackWins; as a defence it would need the attacker
    // on 33..35, which no award produces.
    if (dt < 8) {
      out.impossible++;
      continue;
    }

    // Either a defence won outright (dd === 1, the full 40 kept) or, with no
    // counter moving, a defence that conceded something.
    out.trophyResolved += dt;
    out.battles.push({
      at: cur.captured_at,
      kind: 'defence',
      trophyDelta: dt,
      stars: starsConcededFromDefenderGain(dt),
    });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tags = String(args.tags ?? process.env.WATCH_TAGS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const season = args.season ? String(args.season) : null;

  if (!tags.length) {
    throw new Error(
      'Pass --tags "#TAG" or set WATCH_TAGS. Note dotenv reads an unquoted value ' +
        'beginning with # as a comment, so quote it in .env.',
    );
  }

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

    const first = polls[0];
    const last = polls[polls.length - 1];
    const hours = (Date.parse(last.captured_at) - Date.parse(first.captured_at)) / 3_600_000;
    console.log(
      `${polls.length} polls over ${hours.toFixed(1)}h ` +
        `(${((hours / Math.max(1, polls.length - 1)) * 60).toFixed(1)} min apart)`,
    );

    const r = reconstruct(polls);
    const atk = summarise(r.battles, 'attack');
    const def = summarise(r.battles, 'defence');

    console.log(
      `trophies ${first.trophies} -> ${last.trophies} (moved ${r.trophyMovement}, ` +
        `${r.trophyResolved} attributed to a single battle)`,
    );
    if (r.ambiguous) {
      console.log(
        `  ${r.ambiguous} window(s) held more than one battle — ` +
          `about ${r.ambiguousEvents} event(s) unattributable`,
      );
    }
    if (r.resets) console.log(`  ${r.resets} reset boundary/ies skipped`);
    if (r.impossible) {
      console.log(
        `  ${r.impossible} window(s) with a trophy change no single battle can produce ` +
          '— worth looking at with --events',
      );
    }

    console.log(
      `\nATTACKS   ${atk.count} scoring attacks, ${atk.stars} stars, avg ${atk.average.toFixed(2)}`,
    );
    console.log(
      `          3★ ${atk.hist[3]}   2★ ${atk.hist[2]}   1★ ${atk.hist[1]}   0★ ${atk.hist[0]}`,
    );
    if (atk.count !== r.attackWinsSeen) {
      console.log(
        `          NOTE: attackWins moved ${r.attackWinsSeen} but ${atk.count} were classifiable`,
      );
    }

    console.log(
      `DEFENCES  ${def.count} visible, ${def.stars} stars conceded, avg ${def.average.toFixed(2)}`,
    );
    console.log(
      `          3★ ${def.hist[3]}   2★ ${def.hist[2]}   1★ ${def.hist[1]}   0★ ${def.hist[0]}`,
    );
    console.log(
      '          INCOMPLETE — a defence where the attacker three-stars you pays +0\n' +
        '          and wins nothing, so it moves no counter and no trophy and cannot\n' +
        '          be seen at all. The real 3★ figure is higher than shown and the\n' +
        '          average worse. Subtract the visible count from the defence count on\n' +
        "          the in-game screen to get how many were missed.",
    );

    if (args.events) {
      console.log('\nraw attack gains :', atk.deltas.join(', '));
      console.log('raw defence gains:', def.deltas.join(', '));
      console.log('\nevery classified battle:');
      for (const b of r.battles) {
        console.log(
          `  ${b.at}  ${b.kind.padEnd(8)} ${String(b.trophyDelta).padStart(4)}  ${b.stars}★`,
        );
      }
    }
  }

  console.log(
    '\nCheck the ATTACK histogram against the in-game battle log for the same week. ' +
      'Offence is the side with no blind spot, so if it matches, the trophy-to-star ' +
      'bands are right and this generalises.',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

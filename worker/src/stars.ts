/**
 * Star extraction — THE ONE PLACE TO EDIT once `npm run discover` has shown
 * what the Ranked endpoints actually return.
 *
 * Background: the ranking endpoints are documented to return `attackWins` and
 * `defenseWins`, which are win *counts*. An average like "2.69 stars per
 * attack" cannot be derived from a win count — it needs a star total and an
 * attempt count. Whether Ranked mode exposes those is undocumented.
 *
 * So this module guesses, carefully: it walks a list of candidate field names
 * over the raw row and returns nulls when none match. Nulls flow through to
 * nullable columns and the UI says "no star data" rather than inventing a
 * number. When discovery reveals the real names, add them to the CANDIDATES
 * lists below (or replace the lists outright) and re-run the ingest with
 * --force; nothing else in the codebase needs to change.
 */

/** Ordered candidate paths, most likely first. Dots descend into objects. */
const CANDIDATES = {
  offenceStars: [
    'attackStars',
    'offenceStars',
    'offenseStars',
    'starsGained',
    'attacks.stars',
    'offence.stars',
    'offense.stars',
    'ranked.attackStars',
  ],
  offenceAttacks: [
    'attackCount',
    'attacksUsed',
    'attacksCompleted',
    'totalAttacks',
    'attacks.count',
    'offence.attacks',
    'offense.attacks',
    'ranked.attackCount',
  ],
  defenceStars: [
    'defenseStars',
    'defenceStars',
    'starsLost',
    'starsConceded',
    'defenses.stars',
    'defence.stars',
    'ranked.defenseStars',
  ],
  defenceAttempts: [
    'defenseCount',
    'defenceCount',
    'defensesFaced',
    'totalDefenses',
    'defenses.count',
    'defence.attempts',
    'ranked.defenseCount',
  ],
} as const;

export interface StarStats {
  offence_stars: number | null;
  offence_attacks: number | null;
  defence_stars: number | null;
  defence_attempts: number | null;
}

function readPath(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** First candidate that yields a non-negative finite number, else null. */
function firstNumber(row: unknown, paths: readonly string[]): number | null {
  for (const p of paths) {
    const v = readPath(row, p);
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    // Some Supercell fields come back as numeric strings.
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      const n = Number(v);
      if (n >= 0) return n;
    }
  }
  return null;
}

export function extractStarStats(row: unknown): StarStats {
  return {
    offence_stars: firstNumber(row, CANDIDATES.offenceStars),
    offence_attacks: firstNumber(row, CANDIDATES.offenceAttacks),
    defence_stars: firstNumber(row, CANDIDATES.defenceStars),
    defence_attempts: firstNumber(row, CANDIDATES.defenceAttempts),
  };
}

/**
 * Reports which candidate names matched across a sample of rows. The ingest
 * prints this once per season so a run that silently found nothing is obvious
 * in the logs instead of showing up weeks later as an empty chart.
 */
export function describeStarCoverage(rows: unknown[]): string {
  const found: Record<keyof typeof CANDIDATES, string | null> = {
    offenceStars: null,
    offenceAttacks: null,
    defenceStars: null,
    defenceAttempts: null,
  };

  for (const key of Object.keys(CANDIDATES) as (keyof typeof CANDIDATES)[]) {
    for (const p of CANDIDATES[key]) {
      if (rows.some((r) => firstNumber(r, [p]) !== null)) {
        found[key] = p;
        break;
      }
    }
  }

  const hits = Object.entries(found).filter(([, v]) => v !== null);
  if (hits.length === 0) {
    return 'stars: no candidate field matched — offence/defence averages will be empty. ' +
      'Check worker/discovery/ for the real field names and add them to worker/src/stars.ts.';
  }
  return `stars: matched ${hits.map(([k, v]) => `${k}=${v}`).join(', ')}`;
}

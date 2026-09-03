/**
 * Coverage survey.
 *
 *   npm run survey                 # every country
 *   npm run survey -- --limit 20   # 20 biggest-yielding countries only, faster
 *
 * The probe established that the only ranking endpoint still alive is
 * /locations/{countryId}/rankings/players, that International (32000006) is
 * dead, and that every row carries `leagueTier`. So a Legend II leaderboard is
 * reachable only by sweeping countries and filtering.
 *
 * Before building an ingester on that assumption, this measures whether it is
 * worth having: how many distinct Legend II players a full sweep actually
 * yields, how deep each location pages, and what fields come back. Answer
 * first, build second.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cocFetch, mapLimit, normaliseTag } from './coc.js';

const OUT = path.resolve(process.cwd(), 'worker/discovery');

/** Legend II, from /leaguetiers. */
const LEGEND_II = 105000035;
const LEGEND_TIERS = new Set([105000034, 105000035, 105000036]);

interface Location {
  id: number;
  name: string;
  isCountry?: boolean;
  countryCode?: string;
}

interface RankRow {
  tag: string;
  name?: string;
  expLevel?: number;
  trophies?: number;
  attackWins?: number;
  defenseWins?: number;
  rank?: number;
  previousRank?: number;
  clan?: { tag: string; name?: string };
  leagueTier?: { id: number; name: string };
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

/** Pages one location's ranking to exhaustion, so we learn the real cap. */
async function fetchLocationRanking(id: number): Promise<{ rows: RankRow[]; pages: number }> {
  const rows: RankRow[] = [];
  let after: string | undefined;
  let pages = 0;

  for (; pages < 20; pages++) {
    const res = await cocFetch<{
      items: RankRow[];
      paging?: { cursors?: { after?: string } };
    }>(`/locations/${id}/rankings/players`, { limit: 200, after });

    rows.push(...(res.items ?? []));
    after = res.paging?.cursors?.after;
    if (!after || !res.items?.length) {
      pages++;
      break;
    }
  }
  return { rows, pages };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cap = args.limit ? Number(args.limit) : Infinity;

  if (!process.env.COC_API_TOKEN) throw new Error('COC_API_TOKEN is not set.');
  await mkdir(OUT, { recursive: true });

  const locRes = await cocFetch<{ items: Location[] }>('/locations', { limit: 500 });
  // Only real countries respond; the continent and International rows 404.
  const countries = locRes.items.filter((l) => l.isCountry && l.name);
  console.log(`${countries.length} countries to sweep\n`);

  const byTag = new Map<string, RankRow & { locations: string[] }>();
  const tierCounts = new Map<number, number>();
  let maxPages = 0;
  let maxRows = 0;
  let failures = 0;

  const targets = countries.slice(0, cap === Infinity ? countries.length : cap);

  await mapLimit(targets, async (loc) => {
    try {
      const { rows, pages } = await fetchLocationRanking(loc.id);
      maxPages = Math.max(maxPages, pages);
      maxRows = Math.max(maxRows, rows.length);

      for (const r of rows) {
        const tierId = r.leagueTier?.id ?? 0;
        tierCounts.set(tierId, (tierCounts.get(tierId) ?? 0) + 1);

        const tag = normaliseTag(r.tag);
        const seen = byTag.get(tag);
        if (seen) seen.locations.push(loc.name);
        else byTag.set(tag, { ...r, locations: [loc.name] });
      }

      if (rows.length) {
        const legend = rows.filter((r) => LEGEND_TIERS.has(r.leagueTier?.id ?? 0)).length;
        console.log(
          `  ${loc.name.padEnd(28)} ${String(rows.length).padStart(5)} players` +
            `  ${String(legend).padStart(4)} legend  (${pages} page${pages === 1 ? '' : 's'})`,
        );
      }
    } catch {
      failures++;
    }
  });

  // ------------------------------------------------------------- the answer
  const all = [...byTag.values()];
  const legendII = all.filter((r) => r.leagueTier?.id === LEGEND_II);
  const anyLegend = all.filter((r) => LEGEND_TIERS.has(r.leagueTier?.id ?? 0));

  console.log('\n' + '='.repeat(60));
  console.log(`countries swept        ${targets.length}  (${failures} failed)`);
  console.log(`deepest location       ${maxRows} players over ${maxPages} pages`);
  console.log(`distinct players       ${all.length.toLocaleString()}`);
  console.log(`  any Legend tier      ${anyLegend.length.toLocaleString()}`);
  console.log(`  Legend II only       ${legendII.length.toLocaleString()}`);
  console.log('='.repeat(60));

  console.log('\nplayers per tier:');
  const tierNames = new Map<number, string>();
  for (const r of all) if (r.leagueTier) tierNames.set(r.leagueTier.id, r.leagueTier.name);
  for (const [id, n] of [...tierCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(id).padEnd(10)} ${(tierNames.get(id) ?? '—').padEnd(22)} ${n}`);
  }

  if (legendII.length) {
    console.log('\nsample Legend II row — these are the only fields available:');
    console.log(JSON.stringify(legendII[0], null, 2));
  }

  await writeFile(
    path.join(OUT, 'survey_legend2.json'),
    JSON.stringify({ count: legendII.length, players: legendII }, null, 2),
  );
  console.log(`\nFull Legend II list written to ${OUT}/survey_legend2.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

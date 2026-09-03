/**
 * Clan-route feasibility check.
 *
 *   npm run probe:clans -- --clan "#2GG8Q0QCQ"
 *
 * Location rankings are capped at 200 per country and sorted by trophies, so
 * in any competitive country the top 200 is all Legend I and Legend II is
 * invisible — the sweep returned zero Legend II players for India, the US,
 * Vietnam, Iran, Brazil and ten others.
 *
 * Going via clans avoids that entirely, IF two things hold:
 *
 *   1. clan member rows carry `leagueTier`, so one /clans/{tag} call classifies
 *      up to 50 players at once instead of 50 separate player calls;
 *   2. clan search pages deeper than 200, so the clan population itself isn't
 *      capped the same way.
 *
 * This answers both, and estimates the yield per thousand calls. Nothing gets
 * built on this until the numbers are in.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cocFetch, CocApiError, encodeTag } from './coc.js';

const OUT = path.resolve(process.cwd(), 'worker/discovery');
const LEGEND = new Set([105000034, 105000035, 105000036]);
const LEGEND_II = 105000035;

interface Member {
  tag: string;
  name: string;
  trophies?: number;
  league?: { id: number; name: string };
  leagueTier?: { id: number; name: string };
}

interface Clan {
  tag: string;
  name: string;
  clanLevel?: number;
  clanPoints?: number;
  members?: number;
  memberList?: Member[];
  location?: { id: number; name: string };
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

function reasonOf(err: unknown) {
  if (!(err instanceof CocApiError)) return (err as Error).message;
  try {
    const p = JSON.parse(err.body) as { reason?: string; message?: string };
    return `${err.status} ${[p.reason, p.message].filter(Boolean).join(' — ')}`;
  } catch {
    return `${err.status} ${err.body.slice(0, 80)}`;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clanTag = args.clan;
  if (!process.env.COC_API_TOKEN) throw new Error('COC_API_TOKEN is not set.');
  if (!clanTag) throw new Error('Pass a clan tag:  npm run probe:clans -- --clan "#YOURCLAN"');

  await mkdir(OUT, { recursive: true });

  // ------------------------------------------------- 1. does memberList carry the tier?
  console.log('── Question 1: do clan member rows carry leagueTier? ' + '─'.repeat(12));

  const clan = await cocFetch<Clan>(`/clans/${encodeTag(clanTag)}`);
  const members = clan.memberList ?? [];
  console.log(`  ${clan.name} — ${members.length} members`);

  if (!members.length) {
    console.log('  no member list returned; the clan route needs a different call');
    return;
  }

  const sample = members[0];
  console.log(`  member row fields: ${Object.keys(sample).join(', ')}`);

  const withTier = members.filter((m) => m.leagueTier).length;
  const hasTier = withTier > 0;

  console.log(
    hasTier
      ? `  \x1b[32mYES\x1b[0m — ${withTier}/${members.length} members carry leagueTier`
      : '  \x1b[31mNO\x1b[0m — leagueTier absent; each player would need its own call',
  );
  if (hasTier) {
    console.log(`  sample: ${sample.name} → ${sample.leagueTier?.name} (${sample.leagueTier?.id})`);
  }

  // The dedicated members endpoint may differ from the embedded list.
  try {
    const res = await cocFetch<{ items: Member[] }>(
      `/clans/${encodeTag(clanTag)}/members`,
      { limit: 50 },
    );
    const n = (res.items ?? []).filter((m) => m.leagueTier).length;
    console.log(`  /clans/{tag}/members → ${res.items?.length ?? 0} rows, ${n} with leagueTier`);
  } catch (err) {
    console.log(`  /clans/{tag}/members → ${reasonOf(err)}`);
  }

  await writeFile(path.join(OUT, 'clan_sample.json'), JSON.stringify(clan, null, 2));

  // ------------------------------------------------- 2. how deep does clan search page?
  console.log('\n── Question 2: does clan search page past 200? ' + '─'.repeat(18));

  const seen = new Set<string>();
  let after: string | undefined;
  let pages = 0;
  let capped = false;

  for (; pages < 12; pages++) {
    try {
      const res = await cocFetch<{
        items: Clan[];
        paging?: { cursors?: { after?: string } };
      }>('/clans', { locationId: 32000021, minMembers: 30, limit: 50, after });

      for (const c of res.items ?? []) seen.add(c.tag);
      after = res.paging?.cursors?.after;
      if (!after || !res.items?.length) break;
    } catch (err) {
      console.log(`  stopped at page ${pages + 1}: ${reasonOf(err)}`);
      capped = true;
      break;
    }
  }

  console.log(`  Australia, 30+ members: ${seen.size} clans over ${pages + 1} pages`);
  console.log(
    seen.size > 200 || (!capped && after)
      ? '  \x1b[32mNo 200 cap on clan search\x1b[0m'
      : '  Looks capped — one country alone will not be enough; sweep many locations',
  );

  // ------------------------------------------------- 3. what does a sweep actually yield?
  console.log('\n── Question 3: Legend II yield per clan call ' + '─'.repeat(20));

  if (!hasTier) {
    console.log('  skipped — without leagueTier on members there is nothing to count');
    return;
  }

  const tags = [...seen].slice(0, 40);
  let playersSeen = 0;
  let legendAny = 0;
  let legendII = 0;
  const legendIIRows: Member[] = [];

  for (const t of tags) {
    try {
      const c = await cocFetch<Clan>(`/clans/${encodeTag(t)}`);
      for (const m of c.memberList ?? []) {
        playersSeen++;
        const id = m.leagueTier?.id ?? 0;
        if (LEGEND.has(id)) legendAny++;
        if (id === LEGEND_II) {
          legendII++;
          legendIIRows.push(m);
        }
      }
    } catch { /* a clan going private mid-sweep is normal */ }
  }

  console.log(`  ${tags.length} clans → ${playersSeen} players`);
  console.log(`  any Legend tier : ${legendAny}`);
  console.log(`  Legend II       : ${legendII}`);
  if (playersSeen) {
    const per1000 = Math.round((legendII / tags.length) * 1000);
    console.log(`\n  → roughly ${per1000} Legend II players per 1,000 clan calls`);
    console.log(`  → 20,000 calls (~11 min) would surface about ${(per1000 * 20).toLocaleString()}`);
  }

  if (legendIIRows.length) {
    console.log('\n  sample Legend II member row:');
    console.log(JSON.stringify(legendIIRows[0], null, 2));
    await writeFile(
      path.join(OUT, 'clan_legend2_sample.json'),
      JSON.stringify(legendIIRows, null, 2),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

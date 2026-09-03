/**
 * Clan sweep — the ingest.
 *
 *   npm run sweep -- --discover        rebuild the clan list, then sweep
 *   npm run sweep                      sweep known clans (weekly run)
 *   npm run sweep -- --max-clans 5000  cap the work
 *   npm run sweep -- --no-enrich       skip per-player attack/defence wins
 *
 * Why clans rather than rankings: /locations/{id}/rankings/players caps at 200
 * per country and sorts by trophies, so in competitive countries the top 200 is
 * entirely Legend I and Legend II is invisible — a full country sweep returned
 * zero Legend II players for India, the US, Vietnam, Iran and ten others. Clan
 * member rows carry leagueTier, clan search pages well past 200, and one clan
 * call classifies up to 50 players.
 *
 * Three phases:
 *   A. discovery — /clans by location, paged, upserted. Slow-moving, so it is
 *      opt-in rather than part of every weekly run.
 *   B. sweep — /clans/{tag} for known clans; keep members in the tracked tiers.
 *   C. enrich — /players/{tag} for those members, because attack and defence
 *      wins are not on the clan member row.
 */
import 'dotenv/config';
import { cocFetch, cocFetchAll, encodeTag, mapLimit, normaliseTag, CocApiError } from './coc.js';
import { getDb, upsertChunked } from './db.js';

/** Legend III / II / I, from /leaguetiers. */
const DEFAULT_TIERS = [105000034, 105000035, 105000036];

interface Tier { id: number; name: string; iconUrls?: Record<string, string> }
interface Location { id: number; name: string; isCountry?: boolean; countryCode?: string }

interface Member {
  tag: string;
  name: string;
  townHallLevel?: number;
  expLevel?: number;
  trophies?: number;
  leagueTier?: { id: number; name: string };
}

interface Clan {
  tag: string;
  name: string;
  clanLevel?: number;
  clanPoints?: number;
  members?: number;
  memberList?: Member[];
  badgeUrls?: Record<string, string>;
  location?: { id: number };
}

interface PlayerDetail {
  tag: string;
  name: string;
  attackWins?: number;
  defenseWins?: number;
  trophies?: number;
  townHallLevel?: number;
  leagueTier?: { id: number; name: string };
  clan?: { tag: string };
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

/**
 * The ranked week starts Monday 05:00 UTC (13:00 AWST). Everything captured
 * between two boundaries belongs to the week that began at the earlier one, so
 * a run on Tuesday and a re-run on Thursday land in the same season.
 */
export function seasonIdFor(when: Date): string {
  const d = new Date(when);
  const day = d.getUTCDay();                  // 0 Sun … 1 Mon
  const daysSinceMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  d.setUTCHours(5, 0, 0, 0);
  if (d > when) d.setUTCDate(d.getUTCDate() - 7);   // before Monday 05:00
  return d.toISOString().slice(0, 10);
}

function parseTierName(name: string) {
  const m = name.trim().match(/^(.*?)\s+(I{1,3}|IV|V)$/i);
  const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
  if (m) return { family: m[1].trim(), tier: ROMAN[m[2].toUpperCase()] ?? null };
  const n = name.trim().match(/^(.*?)\s+(\d+)$/);
  if (n) return { family: n[1].trim(), tier: Number(n[2]) };
  return { family: name.trim(), tier: null };
}

// ---------------------------------------------------------------------------

/** Tiers replace leagues: /leagues is legacy and reports Unranked on live rows. */
async function syncReferenceData() {
  const [tiers, locations] = await Promise.all([
    cocFetchAll<Tier>('/leaguetiers', {}, { pageSize: 200 }),
    cocFetchAll<Location>('/locations', {}, { pageSize: 500 }),
  ]);

  await upsertChunked(
    'leagues',
    tiers.map((t) => ({
      id: t.id,
      name: t.name,
      ...parseTierName(t.name),
      icon_urls: t.iconUrls ?? null,
      raw: t,
      updated_at: new Date().toISOString(),
    })),
    'id',
  );

  await upsertChunked(
    'locations',
    locations.map((l) => ({
      id: l.id,
      name: l.name || `Location ${l.id}`,
      is_country: Boolean(l.isCountry),
      country_code: l.countryCode ?? null,
      updated_at: new Date().toISOString(),
    })),
    'id',
  );

  console.log(`reference: ${tiers.length} tiers, ${locations.length} locations`);
  return locations.filter((l) => l.isCountry && l.name);
}

/** Phase A — enumerate clans by country. Only worth re-running occasionally. */
async function discoverClans(countries: Location[], minMembers: number, maxPages: number) {
  console.log(`\ndiscovery: ${countries.length} countries, up to ${maxPages} pages each`);
  let found = 0;

  await mapLimit(countries, async (loc) => {
    const batch: object[] = [];
    let after: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      let res;
      try {
        res = await cocFetch<{
          items: Clan[];
          paging?: { cursors?: { after?: string } };
        }>('/clans', { locationId: loc.id, minMembers, limit: 50, after });
      } catch {
        break;   // a location with no clans answers with an error; move on
      }

      for (const c of res.items ?? []) {
        batch.push({
          tag: normaliseTag(c.tag),
          name: c.name,
          level: c.clanLevel ?? null,
          clan_points: c.clanPoints ?? null,
          member_count: c.members ?? null,
          location_id: loc.id,
          last_seen_at: new Date().toISOString(),
        });
      }

      after = res.paging?.cursors?.after;
      if (!after || !res.items?.length) break;
    }

    if (batch.length) {
      await upsertChunked('clans', batch, 'tag');
      found += batch.length;
      console.log(`  ${loc.name.padEnd(26)} ${batch.length}`);
    }
  }, 6);

  console.log(`discovery: ${found} clan rows upserted`);
}

/** Phase B — read member lists and keep everyone in a tracked tier. */
async function sweepClans(tierIds: Set<number>, maxClans: number) {
  const { data, error } = await getDb()
    .from('clans')
    .select('tag')
    .order('clan_points', { ascending: false, nullsFirst: false })
    .limit(maxClans);

  if (error) throw new Error(`clan selection failed: ${error.message}`);
  const tags = (data ?? []).map((c) => c.tag as string);

  if (!tags.length) {
    throw new Error('No clans stored. Run once with --discover first.');
  }

  console.log(`\nsweep: reading ${tags.length} clans`);

  const members = new Map<string, Member & { clanTag: string; clanName: string }>();
  let playersSeen = 0;
  let clansRead = 0;
  const now = new Date().toISOString();
  const clanUpdates: object[] = [];

  await mapLimit(tags, async (tag) => {
    try {
      const c = await cocFetch<Clan>(`/clans/${encodeTag(tag)}`);
      clansRead++;
      clanUpdates.push({
        tag: normaliseTag(c.tag),
        name: c.name,
        level: c.clanLevel ?? null,
        clan_points: c.clanPoints ?? null,
        member_count: c.members ?? null,
        badge_urls: c.badgeUrls ?? null,
        last_swept_at: now,
        last_seen_at: now,
      });

      for (const m of c.memberList ?? []) {
        playersSeen++;
        if (!m.leagueTier || !tierIds.has(m.leagueTier.id)) continue;
        members.set(normaliseTag(m.tag), {
          ...m,
          clanTag: normaliseTag(c.tag),
          clanName: c.name,
        });
      }

      if (clansRead % 500 === 0) {
        console.log(`  ${clansRead}/${tags.length} clans · ${members.size} tracked players`);
      }
    } catch (err) {
      // A clan going private or being deleted mid-sweep is routine.
      if (!(err instanceof CocApiError && (err.status === 404 || err.status === 403))) throw err;
    }
  });

  if (clanUpdates.length) await upsertChunked('clans', clanUpdates, 'tag');

  console.log(
    `sweep: ${clansRead} clans → ${playersSeen} players → ${members.size} in tracked tiers`,
  );
  return { members, clansRead };
}

/** Phase C — attack and defence wins, which the clan member row omits. */
async function enrichWins(tags: string[]) {
  console.log(`\nenrich: ${tags.length} player records`);
  const out = new Map<string, PlayerDetail>();
  let done = 0;

  await mapLimit(tags, async (tag) => {
    try {
      const p = await cocFetch<PlayerDetail>(`/players/${encodeTag(tag)}`);
      out.set(normaliseTag(p.tag), p);
    } catch (err) {
      if (!(err instanceof CocApiError && err.status === 404)) throw err;
    }
    if (++done % 2000 === 0) console.log(`  ${done}/${tags.length}`);
  });

  console.log(`enrich: ${out.size} records`);
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tierIds = new Set(
    (args.tiers ? String(args.tiers) : process.env.TRACKED_LEAGUE_IDS || '')
      .split(',').map((s) => Number(s.trim())).filter(Boolean),
  );
  if (tierIds.size === 0) DEFAULT_TIERS.forEach((t) => tierIds.add(t));

  const maxClans = Number(args['max-clans'] ?? process.env.MAX_CLANS ?? 20000);
  const capturedAt = new Date();
  const seasonId = seasonIdFor(capturedAt);

  console.log(`tracking tiers: ${[...tierIds].join(', ')}`);
  console.log(`season: ${seasonId} (week beginning Monday 05:00 UTC)`);

  const countries = await syncReferenceData();

  if (args.discover) {
    await discoverClans(
      countries,
      Number(args['min-members'] ?? 30),
      Number(args['max-pages'] ?? 12),
    );
  }

  const { members, clansRead } = await sweepClans(tierIds, maxClans);
  if (members.size === 0) {
    console.log('nothing in the tracked tiers; not recording a snapshot');
    return;
  }

  const wins = args['no-enrich'] ? new Map<string, PlayerDetail>() : await enrichWins([...members.keys()]);

  // One snapshot per tier per week — the same grain the site already reads.
  for (const tierId of tierIds) {
    const inTier = [...members.entries()].filter(([, m]) => m.leagueTier?.id === tierId);
    if (!inTier.length) continue;

    // No global rank exists on this route, so rank is position by trophies
    // within what we captured. The UI labels it as such.
    inTier.sort((a, b) => (b[1].trophies ?? 0) - (a[1].trophies ?? 0));

    // Rank movement needs the prior week's positions; without this the "Move"
    // column on the leaderboard would be blank on every clan-sweep snapshot.
    const { data: prevSnap } = await getDb()
      .from('snapshots')
      .select('id')
      .eq('league_id', tierId)
      .eq('complete', true)
      .lt('captured_at', capturedAt.toISOString())
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevRank = new Map<string, number>();
    if (prevSnap?.id) {
      const { data: prevRows } = await getDb()
        .from('ranking_entries')
        .select('player_tag, rank')
        .eq('snapshot_id', prevSnap.id);
      for (const r of prevRows ?? []) prevRank.set(r.player_tag as string, r.rank as number);
    }

    const { data: snapshot, error } = await getDb()
      .from('snapshots')
      .upsert(
        {
          league_id: tierId,
          season_id: seasonId,
          kind: 'final',
          captured_at: capturedAt.toISOString(),
          source: process.env.COC_API_BASE ?? 'cocproxy',
          method: 'clan_sweep',
          clans_swept: clansRead,
          player_count: inTier.length,
          complete: false,
        },
        { onConflict: 'league_id,season_id,kind' },
      )
      .select('id')
      .single();

    if (error || !snapshot) throw new Error(`snapshot upsert failed: ${error?.message}`);

    const clanRows = new Map<string, object>();
    for (const [, m] of inTier) {
      if (!clanRows.has(m.clanTag)) {
        clanRows.set(m.clanTag, { tag: m.clanTag, name: m.clanName, last_seen_at: capturedAt.toISOString() });
      }
    }
    await upsertChunked('clans', [...clanRows.values()], 'tag');

    await upsertChunked(
      'players',
      inTier.map(([tag, m]) => ({
        tag,
        name: m.name,
        exp_level: m.expLevel ?? null,
        town_hall_level: m.townHallLevel ?? null,
        clan_tag: m.clanTag,
        league_id: tierId,
        last_seen_at: capturedAt.toISOString(),
        // The clan row already carries TH, so the old enrich pass is redundant.
        enriched_at: capturedAt.toISOString(),
      })),
      'tag',
    );

    await upsertChunked(
      'ranking_entries',
      inTier.map(([tag, m], i) => {
        const p = wins.get(tag);
        return {
          snapshot_id: snapshot.id,
          player_tag: tag,
          rank: i + 1,
          previous_rank: prevRank.get(tag) ?? null,
          trophies: m.trophies ?? null,
          exp_level: m.expLevel ?? null,
          player_name: m.name,
          clan_tag: m.clanTag,
          clan_name: m.clanName,
          town_hall_level: m.townHallLevel ?? null,
          attack_wins: p?.attackWins ?? null,
          defense_wins: p?.defenseWins ?? null,
          raw: { member: m, player: p ?? null },
        };
      }),
      'snapshot_id,player_tag',
    );

    await getDb()
      .from('snapshots')
      .update({ complete: true, player_count: inTier.length })
      .eq('id', snapshot.id);

    console.log(`done  tier ${tierId} / ${seasonId} — ${inTier.length} players`);
  }
}

// Only run when invoked directly. Without this guard, importing anything from
// this module (a test importing seasonIdFor, say) starts a full sweep.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

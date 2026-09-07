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
import { getDb, selectPaged, upsertChunked } from './db.js';

/**
 * Legend II by default. Add 105000034 (Legend III) or 105000036 (Legend I) via
 * TRACKED_LEAGUE_IDS — but note each extra tier multiplies the enrichment pass,
 * which is one API call per tracked player and the slowest part of a run.
 */
const DEFAULT_TIERS = [105000035];

interface Tier { id: number; name: string; iconUrls?: Record<string, string> }
interface Location { id: number; name: string; isCountry?: boolean; countryCode?: string }

interface Member {
  tag: string;
  name: string;
  role?: string;
  townHallLevel?: number;
  expLevel?: number;
  trophies?: number;
  clanRank?: number;
  donations?: number;
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
  // Highest clan points first: those clans are where Legend players cluster,
  // so the first N calls are the most productive N calls.
  const rows = await selectPaged<{ tag: string }>(
    (from, to) =>
      getDb()
        .from('clans')
        .select('tag')
        .order('clan_points', { ascending: false, nullsFirst: false })
        .order('tag', { ascending: true })
        .range(from, to),
    { max: maxClans },
  );
  const tags = rows.map((c) => c.tag);

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

/** How many ranking rows a snapshot currently holds. */
export async function countSnapshotRows(snapshotId: number): Promise<number> {
  const { count, error } = await getDb()
    .from('ranking_entries')
    .select('player_tag', { count: 'exact', head: true })
    .eq('snapshot_id', snapshotId);

  if (error) throw new Error(`counting rows for snapshot ${snapshotId} failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Empties a snapshot so the run about to write it owns every row.
 *
 * `ranking_entries` is upserted on (snapshot_id, player_tag): it inserts and
 * updates, but never removes. A second attempt at the same week therefore
 * lands *on top of* whatever the first attempt left, and the two populations
 * are never identical — a sweep reading 5,000 clans sees a different set of
 * players than one reading 20,000. The survivors of the earlier attempt keep
 * ranks assigned from a different field, so the week ends up holding two
 * interleaved rankings and a row count that matches neither run. That is what
 * failed verification on the second week: 9,709 rows present, 7,200 written.
 *
 * Clearing first makes the row set exactly what this run captured. The
 * snapshot is flagged complete = false for the whole write, so the momentary
 * gap is invisible to the site and to every delta computed against it.
 *
 * Returns how many rows were removed.
 */
export async function clearSnapshotRows(snapshotId: number): Promise<number> {
  const before = await countSnapshotRows(snapshotId);
  if (!before) return 0;

  const { error } = await getDb().from('ranking_entries').delete().eq('snapshot_id', snapshotId);

  if (error) {
    const timedOut =
      (error as { code?: string }).code === '57014' || /statement timeout/i.test(error.message);
    if (!timedOut) throw new Error(`clearing snapshot ${snapshotId} failed: ${error.message}`);

    // A statement timeout rolls the whole delete back, so repeating it makes no
    // progress. Go row-group by row-group instead.
    console.warn(`  delete of ${before} rows timed out; clearing in chunks`);
    await clearInChunks(snapshotId);
  }

  const left = await countSnapshotRows(snapshotId);
  if (left) {
    throw new Error(
      `snapshot ${snapshotId} still holds ${left} rows after being cleared; ` +
        'refusing to write a mixed week on top of them',
    );
  }

  return before;
}

/** Deletes a snapshot's rows a tag-group at a time, for when one statement cannot. */
async function clearInChunks(snapshotId: number, chunk = 200) {
  const rows = await selectPaged<{ player_tag: string }>((from, to) =>
    getDb()
      .from('ranking_entries')
      .select('player_tag')
      .eq('snapshot_id', snapshotId)
      .order('player_tag', { ascending: true })
      .range(from, to),
  );

  for (let i = 0; i < rows.length; i += chunk) {
    const tags = rows.slice(i, i + chunk).map((r) => r.player_tag);
    const { error } = await getDb()
      .from('ranking_entries')
      .delete()
      .eq('snapshot_id', snapshotId)
      .in('player_tag', tags);
    if (error) {
      throw new Error(`chunked clear of snapshot ${snapshotId} failed: ${error.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tierIds = new Set(
    (args.tiers ? String(args.tiers) : process.env.TRACKED_LEAGUE_IDS || '')
      .split(',').map((s) => Number(s.trim())).filter(Boolean),
  );
  if (tierIds.size === 0) DEFAULT_TIERS.forEach((t) => tierIds.add(t));

  // Calibrated from a real run: the top 1,000 clans by points yielded 11,883
  // players across all three Legend tiers, so ~5,000 clans is a good hour's
  // worth of coverage for one tier without the enrich pass running away.
  const maxClans = Number(args['max-clans'] ?? process.env.MAX_CLANS ?? 5000);
  const maxEnrich = Number(args['max-enrich'] ?? process.env.MAX_ENRICH ?? 25000);
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

  let wins = new Map<string, PlayerDetail>();
  if (!args['no-enrich']) {
    const toEnrich = [...members.keys()];
    if (toEnrich.length > maxEnrich) {
      console.log(
        `\nenrich: ${toEnrich.length} players exceeds --max-enrich ${maxEnrich}; ` +
          'capping. Attack/defence wins will be missing for the remainder — raise ' +
          '--max-enrich or lower --max-clans.',
      );
    }
    console.log(
      `\nenrich: about ${Math.ceil(Math.min(toEnrich.length, maxEnrich) / 600)} min at ` +
        `${process.env.COC_CONCURRENCY ?? 10} concurrent`,
    );
    wins = await enrichWins(toEnrich.slice(0, maxEnrich));
  }

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
      const prevRows = await selectPaged<{ player_tag: string; rank: number }>((from, to) =>
        getDb()
          .from('ranking_entries')
          .select('player_tag, rank')
          .eq('snapshot_id', prevSnap.id)
          .order('rank', { ascending: true })
          .range(from, to),
      );
      for (const r of prevRows) prevRank.set(r.player_tag, r.rank);
    }

    // The uniqueness rule here is a PARTIAL index —
    //   unique (league_id, season_id) where kind = 'final'
    // — and Postgres only infers a partial index for ON CONFLICT when the
    // statement repeats its WHERE predicate, which PostgREST's onConflict
    // (bare column names) cannot express. So look the row up and insert or
    // update explicitly. The index still guards against a concurrent double
    // insert; we simply cannot route through ON CONFLICT.
    const header = {
      league_id: tierId,
      season_id: seasonId,
      kind: 'final',
      captured_at: capturedAt.toISOString(),
      source: process.env.COC_API_BASE ?? 'cocproxy',
      method: 'clan_sweep',
      clans_swept: clansRead,
      player_count: inTier.length,
      complete: false,
    };

    const { data: existing } = await getDb()
      .from('snapshots')
      .select('id')
      .eq('league_id', tierId)
      .eq('season_id', seasonId)
      .eq('kind', 'final')
      .maybeSingle();

    let snapshotId: number;

    if (existing?.id) {
      const { error } = await getDb().from('snapshots').update(header).eq('id', existing.id);
      if (error) throw new Error(`snapshot update failed: ${error.message}`);
      snapshotId = existing.id as number;
    } else {
      const { data, error } = await getDb()
        .from('snapshots')
        .insert(header)
        .select('id')
        .single();
      if (error || !data) throw new Error(`snapshot insert failed: ${error?.message}`);
      snapshotId = data.id as number;
    }

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

    // Make this run's row set authoritative for the week before writing it.
    // See clearSnapshotRows: an upsert never removes, so a re-run that captures
    // a different population than an earlier attempt at the same week would
    // otherwise leave the difference behind.
    const cleared = await clearSnapshotRows(snapshotId);
    if (cleared) {
      console.log(`cleared ${cleared} rows from an earlier attempt at ${seasonId}`);
    }

    await upsertChunked(
      'ranking_entries',
      inTier.map(([tag, m], i) => {
        const p = wins.get(tag);
        return {
          snapshot_id: snapshotId,
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
          // Deliberately NOT the whole API response. A player record is ~40KB
          // of troops, heroes, equipment and achievements; storing it per
          // player per week is tens of megabytes a run, blew the statement
          // timeout, and none of it is read. Everything used has a typed
          // column, so `raw` keeps only the few extra member fields that might
          // become interesting later.
          raw: {
            role: m.role ?? null,
            clanRank: m.clanRank ?? null,
            donations: m.donations ?? null,
          },
        };
      }),
      'snapshot_id,player_tag',
      500,
    );

    // Read the row count back before marking the snapshot complete. Writes can
    // fail partially, and a snapshot flagged complete with half its players is
    // worse than one that visibly failed — every week-over-week delta computed
    // against it would be wrong.
    const count = await countSnapshotRows(snapshotId);

    if (count !== inTier.length) {
      throw new Error(
        `snapshot ${snapshotId} holds ${count} rows but ${inTier.length} were written; ` +
          'leaving it incomplete rather than recording a partial week',
      );
    }

    await getDb()
      .from('snapshots')
      .update({ complete: true, player_count: inTier.length })
      .eq('id', snapshotId);

    console.log(`done  tier ${tierId} / ${seasonId} — ${inTier.length} players verified`);
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

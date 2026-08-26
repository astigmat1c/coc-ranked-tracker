/**
 * Weekly ingest: capture the end-of-season standings for the tracked leagues.
 *
 *   npm run ingest                      # latest season of every tracked league
 *   npm run ingest -- --season 2026-08-24
 *   npm run ingest -- --league 105000035 --force
 *   npm run ingest -- --backfill 12     # last 12 seasons, for a cold start
 *
 * Idempotent: a completed snapshot for a (league, season) is skipped unless
 * --force is passed, so a retried cron run costs one cheap API call.
 */
import 'dotenv/config';
import { cocFetch, cocFetchAll, normaliseTag } from './coc.js';
import { db, upsertChunked } from './db.js';

interface League {
  id: number;
  name: string;
  iconUrls?: Record<string, string>;
}

interface Location {
  id: number;
  name: string;
  isCountry?: boolean;
  countryCode?: string;
}

interface RankingRow {
  tag: string;
  name?: string;
  expLevel?: number;
  rank: number;
  previousRank?: number;
  trophies?: number;
  attackWins?: number;
  defenseWins?: number;
  townHallLevel?: number;
  clan?: { tag: string; name?: string; badgeUrls?: Record<string, string>; level?: number };
  league?: { id: number; name: string };
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * "Legend II" -> { family: 'Legend', tier: 2 }. Used for grouping and for
 * letting the UI sort tiers correctly instead of alphabetically.
 */
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

function parseLeagueName(name: string) {
  const m = name.trim().match(/^(.*?)\s+(I{1,3}|IV|V)$/i);
  if (m) return { family: m[1].trim(), tier: ROMAN[m[2].toUpperCase()] ?? null };
  const n = name.trim().match(/^(.*?)\s+(\d+)$/);
  if (n) return { family: n[1].trim(), tier: Number(n[2]) };
  return { family: name.trim(), tier: null };
}

// ---------------------------------------------------------------------------

async function syncReferenceData() {
  const [leagues, locations] = await Promise.all([
    cocFetchAll<League>('/leagues', {}, { pageSize: 200 }),
    cocFetchAll<Location>('/locations', {}, { pageSize: 500 }),
  ]);

  await upsertChunked(
    'leagues',
    leagues.map((l) => ({
      id: l.id,
      name: l.name,
      ...parseLeagueName(l.name),
      icon_urls: l.iconUrls ?? null,
      raw: l,
      updated_at: new Date().toISOString(),
    })),
    'id',
  );

  await upsertChunked(
    'locations',
    locations.map((l) => ({
      id: l.id,
      name: l.name,
      is_country: Boolean(l.isCountry),
      country_code: l.countryCode ?? null,
      updated_at: new Date().toISOString(),
    })),
    'id',
  );

  console.log(`reference data: ${leagues.length} leagues, ${locations.length} locations`);
  return leagues;
}

/** Which leagues to track. Defaults to every Legend tier the API exposes. */
function resolveTrackedLeagues(all: League[], override?: string): League[] {
  const env = override ?? process.env.TRACKED_LEAGUE_IDS;
  if (env) {
    const ids = new Set(String(env).split(',').map((s) => Number(s.trim())));
    return all.filter((l) => ids.has(l.id));
  }
  const legend = all.filter((l) => /legend/i.test(l.name));
  return legend.length ? legend : all.slice(-3);
}

async function seasonsFor(leagueId: number): Promise<string[]> {
  const res = await cocFetch<{ items: { id: string }[] }>(
    `/leagues/${leagueId}/seasons`,
    { limit: 100 },
  );
  // The API returns oldest-first; normalise to newest-first.
  return (res.items ?? []).map((s) => s.id).sort().reverse();
}

async function ingestSeason(league: League, seasonId: string, force: boolean) {
  const label = `${league.name} (${league.id}) / ${seasonId}`;

  const { data: existing } = await db
    .from('snapshots')
    .select('id, complete, player_count')
    .eq('league_id', league.id)
    .eq('season_id', seasonId)
    .eq('kind', 'final')
    .maybeSingle();

  if (existing?.complete && !force) {
    console.log(`skip  ${label} — already captured (${existing.player_count} players)`);
    return;
  }

  console.log(`pull  ${label}`);
  const rows = await cocFetchAll<RankingRow>(
    `/leagues/${league.id}/seasons/${encodeURIComponent(seasonId)}`,
    {},
    { pageSize: 1000 },
  );

  if (rows.length === 0) {
    console.log(`warn  ${label} — empty ranking, not recording a snapshot`);
    return;
  }

  // Snapshot header first, so a crash mid-write leaves an obviously incomplete
  // row rather than a silently truncated leaderboard.
  const { data: snapshot, error: snapErr } = await db
    .from('snapshots')
    .upsert(
      {
        ...(existing?.id ? { id: existing.id } : {}),
        league_id: league.id,
        season_id: seasonId,
        kind: 'final',
        captured_at: new Date().toISOString(),
        source: process.env.COC_API_BASE ?? 'cocproxy',
        player_count: rows.length,
        complete: false,
      },
      { onConflict: existing?.id ? 'id' : 'league_id,season_id,kind' },
    )
    .select('id')
    .single();

  if (snapErr || !snapshot) throw new Error(`snapshot upsert failed: ${snapErr?.message}`);

  const now = new Date().toISOString();

  // Clans first — players reference them.
  const clans = new Map<string, object>();
  for (const r of rows) {
    if (!r.clan?.tag) continue;
    const tag = normaliseTag(r.clan.tag);
    if (clans.has(tag)) continue;
    clans.set(tag, {
      tag,
      name: r.clan.name ?? null,
      badge_urls: r.clan.badgeUrls ?? null,
      level: r.clan.level ?? null,
      raw: r.clan,
      last_seen_at: now,
    });
  }
  await upsertChunked('clans', [...clans.values()], 'tag');

  await upsertChunked(
    'players',
    rows.map((r) => ({
      tag: normaliseTag(r.tag),
      name: r.name ?? null,
      exp_level: r.expLevel ?? null,
      clan_tag: r.clan?.tag ? normaliseTag(r.clan.tag) : null,
      league_id: r.league?.id ?? league.id,
      last_seen_at: now,
    })),
    'tag',
  );

  await upsertChunked(
    'ranking_entries',
    rows.map((r) => ({
      snapshot_id: snapshot.id,
      player_tag: normaliseTag(r.tag),
      rank: r.rank,
      previous_rank: r.previousRank ?? null,
      trophies: r.trophies ?? null,
      attack_wins: r.attackWins ?? null,
      defense_wins: r.defenseWins ?? null,
      exp_level: r.expLevel ?? null,
      player_name: r.name ?? null,
      clan_tag: r.clan?.tag ? normaliseTag(r.clan.tag) : null,
      clan_name: r.clan?.name ?? null,
      town_hall_level: r.townHallLevel ?? null,
      raw: r,
    })),
    'snapshot_id,player_tag',
  );

  await db
    .from('snapshots')
    .update({ complete: true, player_count: rows.length })
    .eq('id', snapshot.id);

  console.log(`done  ${label} — ${rows.length} players, ${clans.size} clans`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const force = Boolean(args.force);
  const backfill = args.backfill ? Number(args.backfill) : 1;

  const allLeagues = await syncReferenceData();
  const tracked = resolveTrackedLeagues(allLeagues, args.league as string | undefined);

  if (tracked.length === 0) {
    throw new Error(
      'No leagues matched. Run `npm run discover` to see the IDs the API exposes, ' +
        'then set TRACKED_LEAGUE_IDS.',
    );
  }
  console.log(`tracking: ${tracked.map((l) => `${l.name}(${l.id})`).join(', ')}\n`);

  for (const league of tracked) {
    let seasons: string[];
    try {
      seasons = await seasonsFor(league.id);
    } catch {
      console.log(`warn  ${league.name} (${league.id}) exposes no season history — skipping`);
      continue;
    }

    const targets = args.season ? [String(args.season)] : seasons.slice(0, backfill);
    for (const seasonId of targets) {
      try {
        await ingestSeason(league, seasonId, force);
      } catch (err) {
        // One bad league-season shouldn't abort the whole weekly run.
        console.error(`fail  ${league.name} / ${seasonId}:`, (err as Error).message);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

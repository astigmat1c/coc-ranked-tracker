import { getSupabase } from './supabase';
import type {
  LeaderboardFilters,
  LeaderboardRow,
  LeagueRow,
  PlayerHistoryRow,
  SnapshotRow,
  ComparisonRow,
} from './types';

export const DEFAULT_PAGE_SIZE = 100;

/** Sort keys the UI is allowed to pass through to Postgres. */
const SORTABLE = new Set([
  'rank',
  'trophies',
  'attack_wins',
  'defense_wins',
  'town_hall_level',
  'exp_level',
  'rank_delta',
  'player_name',
  'clan_name',
]);

export async function getLeagues(): Promise<LeagueRow[]> {
  const { data, error } = await getSupabase()
    .from('leagues')
    .select('id, name, family, tier, icon_urls')
    .order('id', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Leagues we actually hold data for — the only ones worth showing in a picker. */
export async function getTrackedLeagues(): Promise<LeagueRow[]> {
  const { data, error } = await getSupabase()
    .from('snapshots')
    .select('league_id, leagues!inner(id, name, family, tier, icon_urls)')
    .eq('complete', true);

  if (error) throw new Error(error.message);

  const byId = new Map<number, LeagueRow>();
  for (const row of data ?? []) {
    const l = (row as unknown as { leagues: LeagueRow }).leagues;
    if (l) byId.set(l.id, l);
  }
  return [...byId.values()].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) || a.id - b.id);
}

export async function getSeasons(leagueId: number): Promise<SnapshotRow[]> {
  const { data, error } = await getSupabase()
    .from('snapshots')
    .select('id, league_id, season_id, kind, captured_at, player_count, complete')
    .eq('league_id', leagueId)
    .eq('kind', 'final')
    .eq('complete', true)
    .order('season_id', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as SnapshotRow[];
}

export async function getLatestSnapshot(leagueId?: number): Promise<SnapshotRow | null> {
  let q = getSupabase()
    .from('snapshots')
    .select('id, league_id, season_id, kind, captured_at, player_count, complete')
    .eq('complete', true)
    .order('captured_at', { ascending: false })
    .limit(1);

  if (leagueId) q = q.eq('league_id', leagueId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data?.[0] as SnapshotRow) ?? null;
}

export async function getLeaderboard(filters: LeaderboardFilters): Promise<{
  rows: LeaderboardRow[];
  total: number;
}> {
  const {
    leagueId,
    seasonId,
    search,
    clan,
    countryCode,
    townHall,
    minTrophies,
    maxTrophies,
    sort = 'rank',
    dir = 'asc',
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = filters;

  let q = getSupabase().from('leaderboard').select('*', { count: 'exact' });

  if (leagueId) q = q.eq('league_id', leagueId);
  if (seasonId) q = q.eq('season_id', seasonId);
  if (townHall) q = q.eq('town_hall_level', townHall);
  if (countryCode) q = q.eq('clan_country_code', countryCode);
  if (minTrophies) q = q.gte('trophies', minTrophies);
  if (maxTrophies) q = q.lte('trophies', maxTrophies);

  if (clan) {
    // Accept either a clan tag or a partial clan name.
    q = clan.startsWith('#')
      ? q.eq('clan_tag', clan.toUpperCase())
      : q.ilike('clan_name', `%${clan}%`);
  }

  if (search) {
    const term = search.trim();
    q = term.startsWith('#')
      ? q.eq('player_tag', term.toUpperCase())
      : q.ilike('player_name', `%${term}%`);
  }

  const sortKey = SORTABLE.has(sort) ? sort : 'rank';
  const from = (page - 1) * pageSize;

  const { data, error, count } = await q
    .order(sortKey, { ascending: dir === 'asc', nullsFirst: false })
    // Stable tiebreak so pagination doesn't shuffle rows between pages.
    .order('rank', { ascending: true })
    .range(from, from + pageSize - 1);

  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as LeaderboardRow[], total: count ?? 0 };
}

export async function getPlayerHistory(tag: string): Promise<PlayerHistoryRow[]> {
  const { data, error } = await getSupabase()
    .from('player_history')
    .select('*')
    .eq('player_tag', tag.toUpperCase())
    .order('captured_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as PlayerHistoryRow[];
}

export async function getPlayer(tag: string) {
  const { data, error } = await getSupabase()
    .from('players')
    .select('tag, name, exp_level, town_hall_level, clan_tag, league_id, enriched_at')
    .eq('tag', tag.toUpperCase())
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

/** Distinct countries present in a snapshot, for the country filter dropdown. */
export async function getCountriesInSeason(leagueId: number, seasonId: string) {
  const { data, error } = await getSupabase()
    .from('leaderboard')
    .select('clan_country_code, clan_location_name')
    .eq('league_id', leagueId)
    .eq('season_id', seasonId)
    .not('clan_country_code', 'is', null);

  if (error) throw new Error(error.message);

  const seen = new Map<string, string>();
  for (const r of data ?? []) {
    const row = r as { clan_country_code: string; clan_location_name: string };
    if (!seen.has(row.clan_country_code)) seen.set(row.clan_country_code, row.clan_location_name);
  }
  return [...seen.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Offence vs defence comparison
//
// Stars do not exist anywhere in the API — every ranking and player row carries
// win counts, and no arithmetic turns a win count into stars per attack. This
// runs on attack and defence wins instead, measured as week-over-week deltas.
// ---------------------------------------------------------------------------

/** Postgres `numeric` and `bigint` arrive as strings over PostgREST. */
const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Attack wins per week over the chosen offence weeks against defence wins per
 * week over the chosen defence weeks. The two lists are independent and need
 * not be contiguous. Only players present in every selected week on both sides
 * are returned.
 */
export async function getComparison(
  leagueId: number,
  offenceSeasons: string[],
  defenceSeasons: string[],
): Promise<ComparisonRow[]> {
  if (offenceSeasons.length === 0 || defenceSeasons.length === 0) return [];

  const { data, error } = await getSupabase().rpc('performance_comparison', {
    p_league_id: leagueId,
    p_offence_seasons: offenceSeasons,
    p_defence_seasons: defenceSeasons,
  });

  if (error) throw new Error(error.message);

  return (data ?? []).map((r: Record<string, unknown>) => ({
    player_tag: String(r.player_tag),
    player_name: (r.player_name as string) ?? null,
    clan_tag: (r.clan_tag as string) ?? null,
    clan_name: (r.clan_name as string) ?? null,
    town_hall_level: toNum(r.town_hall_level),
    offence_weeks: toNum(r.offence_weeks) ?? 0,
    defence_weeks: toNum(r.defence_weeks) ?? 0,
    offence_total: toNum(r.offence_total),
    offence_avg: toNum(r.offence_avg),
    defence_total: toNum(r.defence_total),
    defence_avg: toNum(r.defence_avg),
    latest_rank: toNum(r.latest_rank),
    latest_trophies: toNum(r.latest_trophies),
  }));
}

/**
 * Week-over-week deltas need two completed snapshots, so a freshly seeded
 * database has nothing to compare and the page should say so rather than
 * showing an empty chart.
 */
export async function hasComparisonData(leagueId: number): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('comparison_data_available', {
    p_league_id: leagueId,
  });

  if (error) throw new Error(error.message);
  return Boolean(data);
}

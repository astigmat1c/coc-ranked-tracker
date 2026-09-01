export interface LeagueRow {
  id: number;
  name: string;
  family: string | null;
  tier: number | null;
  icon_urls: Record<string, string> | null;
}

export interface SnapshotRow {
  id: number;
  league_id: number;
  season_id: string;
  kind: 'final' | 'interim';
  captured_at: string;
  player_count: number;
  complete: boolean;
}

export interface LeaderboardRow {
  snapshot_id: number;
  league_id: number;
  season_id: string;
  league_name: string;
  player_tag: string;
  player_name: string | null;
  rank: number;
  previous_rank: number | null;
  rank_delta: number | null;
  trophies: number | null;
  attack_wins: number | null;
  defense_wins: number | null;
  exp_level: number | null;
  town_hall_level: number | null;
  clan_tag: string | null;
  clan_name: string | null;
  clan_location_id: number | null;
  clan_location_name: string | null;
  clan_country_code: string | null;
}

export interface PlayerHistoryRow {
  player_tag: string;
  league_id: number;
  league_name: string;
  season_id: string;
  kind: string;
  captured_at: string;
  rank: number;
  trophies: number | null;
  attack_wins: number | null;
  defense_wins: number | null;
  clan_tag: string | null;
  clan_name: string | null;
}

/** One row of the offence-vs-defence comparison, as star_comparison() returns it. */
export interface StarComparisonRow {
  player_tag: string;
  player_name: string | null;
  clan_tag: string | null;
  clan_name: string | null;
  town_hall_level: number | null;
  offence_weeks: number;
  defence_weeks: number;
  offence_stars: number | null;
  offence_attacks: number | null;
  offence_avg: number | null;
  defence_stars: number | null;
  defence_attempts: number | null;
  defence_avg: number | null;
  latest_rank: number | null;
  latest_trophies: number | null;
}

/**
 * Wire format for the comparison page. A full Legend tier is ~10k rows, and
 * shipping them as objects repeats every key 10k times — about 2.7MB of HTML
 * measured at 8k players. As positional tuples carrying only the fields the
 * page actually renders, the same data is roughly a third of that.
 *
 * Order: tag, name, clan, TH, offence avg, defence avg, attacks, defences, rank.
 */
export type StarTuple = [
  string,
  string | null,
  string | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export function toStarTuple(r: StarComparisonRow): StarTuple {
  return [
    r.player_tag,
    r.player_name,
    r.clan_name,
    r.town_hall_level,
    r.offence_avg,
    r.defence_avg,
    r.offence_attacks,
    r.defence_attempts,
    r.latest_rank,
  ];
}

export interface StarPoint {
  player_tag: string;
  player_name: string | null;
  clan_name: string | null;
  town_hall_level: number | null;
  offence_avg: number | null;
  defence_avg: number | null;
  offence_attacks: number | null;
  defence_attempts: number | null;
  latest_rank: number | null;
  /** Offence average minus defence average; positive means net taker. */
  gap: number | null;
}

export function fromStarTuple(t: StarTuple): StarPoint {
  const [tag, name, clan, th, off, def, attacks, defences, rank] = t;
  return {
    player_tag: tag,
    player_name: name,
    clan_name: clan,
    town_hall_level: th,
    offence_avg: off,
    defence_avg: def,
    offence_attacks: attacks,
    defence_attempts: defences,
    latest_rank: rank,
    gap: off !== null && def !== null ? Number((off - def).toFixed(3)) : null,
  };
}

export interface LeaderboardFilters {
  leagueId?: number;
  seasonId?: string;
  search?: string;
  clan?: string;
  countryCode?: string;
  townHall?: number;
  minTrophies?: number;
  maxTrophies?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

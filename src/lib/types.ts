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

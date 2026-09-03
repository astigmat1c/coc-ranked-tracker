-- Pivot from the (dead) league-season endpoints to the clan sweep.
--
-- What changed and why:
--
--   * Legend II is a league *tier* (105000035), not a league. /leagues returns
--     only the 23 legacy leagues, all of which now report "Unranked" on live
--     rows, so the `leagues` table is repopulated from /leaguetiers instead.
--     Tier ids slot straight into league_id, so every existing view, query and
--     page keeps working.
--
--   * There is no ranking endpoint under a tier, and /locations rankings cap at
--     200 per country sorted by trophies — which returned zero Legend II
--     players for India, the US and eleven other large countries. Population
--     now comes from sweeping clans, whose member rows carry leagueTier.
--
--   * A clan sweep has no global rank, so `rank` is derived: position by
--     trophies within the players we actually captured. It is a rank within the
--     tracked set and the UI says so.
--
--   * Stars do not exist anywhere in the API. The offence/defence comparison
--     runs on attack and defence *wins*, measured as deltas between snapshots.

-- Clan sweep bookkeeping.
alter table clans
  add column if not exists clan_points    integer,
  add column if not exists member_count   integer,
  add column if not exists last_swept_at  timestamptz;

create index if not exists clans_sweep_idx on clans (last_swept_at nulls first);
create index if not exists clans_points_idx on clans (clan_points desc nulls last);

-- Snapshot provenance: a clan sweep and a ranking pull are not the same thing
-- and should not be silently comparable.
alter table snapshots
  add column if not exists method       text,
  add column if not exists clans_swept  integer;

comment on column snapshots.method is
  'How the population was gathered: clan_sweep, or location_ranking for legacy rows.';

-- Per-week deltas need the previous snapshot's counters, so keep the raw
-- cumulative values and derive the difference in the view below.
comment on column ranking_entries.attack_wins is
  'Attack wins as reported at capture. Per-week figures come from the delta '
  'against the previous snapshot, which is reset-safe.';

-- ---------------------------------------------------------------------------
-- Weekly deltas
--
-- The counters may or may not reset at the weekly boundary — the evidence is
-- suggestive (Legend II players cluster at exactly 30 attack wins) but not
-- proven. Deltas work either way: a drop means the counter reset, so the new
-- value is itself the week's figure; otherwise the week's figure is the rise.
-- ---------------------------------------------------------------------------

create or replace view player_week_stats as
with ordered as (
  select
    e.player_tag,
    s.id                as snapshot_id,
    s.league_id,
    s.season_id,
    s.captured_at,
    e.trophies,
    e.attack_wins,
    e.defense_wins,
    e.town_hall_level,
    e.player_name,
    e.clan_tag,
    e.clan_name,
    lag(e.attack_wins)  over w as prev_attack_wins,
    lag(e.defense_wins) over w as prev_defense_wins,
    lag(e.trophies)     over w as prev_trophies
  from ranking_entries e
  join snapshots s on s.id = e.snapshot_id
  where s.complete
  window w as (partition by e.player_tag, s.league_id order by s.captured_at)
)
select
  player_tag,
  snapshot_id,
  league_id,
  season_id,
  captured_at,
  player_name,
  clan_tag,
  clan_name,
  town_hall_level,
  trophies,
  trophies - prev_trophies as trophy_delta,
  attack_wins,
  defense_wins,
  case
    when prev_attack_wins is null then null
    when attack_wins >= prev_attack_wins then attack_wins - prev_attack_wins
    else attack_wins                                   -- counter reset
  end as attack_wins_week,
  case
    when prev_defense_wins is null then null
    when defense_wins >= prev_defense_wins then defense_wins - prev_defense_wins
    else defense_wins
  end as defence_wins_week
from ordered;

alter view player_week_stats set (security_invoker = on);
grant select on player_week_stats to anon, authenticated;

-- ---------------------------------------------------------------------------
-- performance_comparison — the offence/defence page, on wins rather than stars
--
-- Same contract as the function it replaces: two independent, not necessarily
-- contiguous week lists, and only players present in every selected week on
-- both sides.
-- ---------------------------------------------------------------------------

drop function if exists star_comparison(integer, text[], text[]);

create or replace function performance_comparison(
  p_league_id       integer,
  p_offence_seasons text[],
  p_defence_seasons text[]
)
returns table (
  player_tag        text,
  player_name       text,
  clan_tag          text,
  clan_name         text,
  town_hall_level   integer,
  offence_weeks     integer,
  defence_weeks     integer,
  offence_total     bigint,
  offence_avg       numeric,
  defence_total     bigint,
  defence_avg       numeric,
  latest_rank       integer,
  latest_trophies   integer
)
language sql
stable
security invoker
as $$
  with off_weeks as (
    select id from snapshots
    where league_id = p_league_id and complete and season_id = any(p_offence_seasons)
  ),
  def_weeks as (
    select id, captured_at from snapshots
    where league_id = p_league_id and complete and season_id = any(p_defence_seasons)
  ),
  n as (
    select (select count(*) from off_weeks) as n_off,
           (select count(*) from def_weeks) as n_def
  ),
  offence as (
    select w.player_tag,
           count(*)::int              as weeks,
           sum(w.attack_wins_week)    as total
    from player_week_stats w
    join off_weeks o on o.id = w.snapshot_id
    where w.attack_wins_week is not null
    group by w.player_tag
    having count(*) = (select n_off from n)
  ),
  defence as (
    select w.player_tag,
           count(*)::int              as weeks,
           sum(w.defence_wins_week)   as total
    from player_week_stats w
    join def_weeks d on d.id = w.snapshot_id
    where w.defence_wins_week is not null
    group by w.player_tag
    having count(*) = (select n_def from n)
  ),
  latest as (
    select distinct on (e.player_tag)
      e.player_tag, e.player_name, e.clan_tag, e.clan_name,
      e.town_hall_level, e.rank, e.trophies
    from ranking_entries e
    join def_weeks d on d.id = e.snapshot_id
    order by e.player_tag, d.captured_at desc
  )
  select
    o.player_tag,
    l.player_name,
    l.clan_tag,
    l.clan_name,
    l.town_hall_level,
    o.weeks,
    d.weeks,
    o.total,
    round(o.total::numeric / nullif(o.weeks, 0), 2),
    d.total,
    round(d.total::numeric / nullif(d.weeks, 0), 2),
    l.rank,
    l.trophies
  from offence o
  join defence d on d.player_tag = o.player_tag
  join latest  l on l.player_tag = o.player_tag
  where (select n_off from n) > 0 and (select n_def from n) > 0
  order by round(o.total::numeric / nullif(o.weeks, 0), 2) desc nulls last;
$$;

grant execute on function performance_comparison(integer, text[], text[]) to anon, authenticated;

-- Renamed availability probe: the question is now whether any week-over-week
-- deltas exist yet, which needs at least two completed snapshots.
drop function if exists star_data_available(integer);

create or replace function comparison_data_available(p_league_id integer)
returns boolean
language sql
stable
security invoker
as $$
  select (
    select count(*) from snapshots where league_id = p_league_id and complete
  ) >= 2;
$$;

grant execute on function comparison_data_available(integer) to anon, authenticated;

-- Explicit week selection.
--
-- 0002 took a rolling window ("last N weeks"), which can't express a selection
-- like "3, 10 and 17 August for offence, 24 August alone for defence" — and
-- can't skip a week at all. This replaces it with two explicit season lists.
-- The old two-integer signature is dropped rather than left to shadow the new
-- one; nothing but the app called it.

drop function if exists star_comparison(integer, integer);

create or replace function star_comparison(
  p_league_id       integer,
  p_offence_seasons text[],
  p_defence_seasons text[]
)
returns table (
  player_tag         text,
  player_name        text,
  clan_tag           text,
  clan_name          text,
  town_hall_level    integer,
  offence_weeks      integer,
  defence_weeks      integer,
  offence_stars      bigint,
  offence_attacks    bigint,
  offence_avg        numeric,
  defence_stars      bigint,
  defence_attempts   bigint,
  defence_avg        numeric,
  latest_rank        integer,
  latest_trophies    integer
)
language sql
stable
security invoker
as $$
  with off_weeks as (
    select id from snapshots
    where league_id = p_league_id
      and kind = 'final'
      and complete
      and season_id = any(p_offence_seasons)
  ),
  def_weeks as (
    select id, captured_at from snapshots
    where league_id = p_league_id
      and kind = 'final'
      and complete
      and season_id = any(p_defence_seasons)
  ),
  -- Counted from the snapshots that actually exist, not from the requested
  -- array: a stale season id in a bookmarked URL should drop out quietly
  -- rather than make the "present every week" test impossible to satisfy.
  n as (
    select (select count(*) from off_weeks) as n_off,
           (select count(*) from def_weeks) as n_def
  ),
  offence as (
    select
      e.player_tag,
      count(*)::int          as weeks,
      sum(e.offence_stars)   as stars,
      sum(e.offence_attacks) as attacks
    from ranking_entries e
    join off_weeks w on w.id = e.snapshot_id
    group by e.player_tag
    having count(*) = (select n_off from n)
       and coalesce(sum(e.offence_attacks), 0) > 0
  ),
  defence as (
    select
      e.player_tag,
      count(*)::int            as weeks,
      sum(e.defence_stars)     as stars,
      sum(e.defence_attempts)  as attempts
    from ranking_entries e
    join def_weeks w on w.id = e.snapshot_id
    group by e.player_tag
    having count(*) = (select n_def from n)
       and coalesce(sum(e.defence_attempts), 0) > 0
  ),
  -- Identity and standing come from the most recent selected defence week, so
  -- the name and clan shown are the freshest the selection covers.
  latest as (
    select distinct on (e.player_tag)
      e.player_tag, e.player_name, e.clan_tag, e.clan_name,
      e.town_hall_level, e.rank, e.trophies
    from ranking_entries e
    join def_weeks w on w.id = e.snapshot_id
    order by e.player_tag, w.captured_at desc
  )
  select
    o.player_tag,
    l.player_name,
    l.clan_tag,
    l.clan_name,
    l.town_hall_level,
    o.weeks,
    d.weeks,
    o.stars,
    o.attacks,
    round(o.stars::numeric / nullif(o.attacks, 0), 3),
    d.stars,
    d.attempts,
    round(d.stars::numeric / nullif(d.attempts, 0), 3),
    l.rank,
    l.trophies
  from offence o
  join defence d on d.player_tag = o.player_tag
  join latest  l on l.player_tag = o.player_tag
  where (select n_off from n) > 0 and (select n_def from n) > 0
  order by round(o.stars::numeric / nullif(o.attacks, 0), 3) desc nulls last;
$$;

grant execute on function star_comparison(integer, text[], text[]) to anon, authenticated;

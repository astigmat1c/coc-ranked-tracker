-- Star statistics: per-season offence and defence totals, and the query that
-- compares an N-week offence average against the latest week's defence.
--
-- These columns are nullable on purpose. The ranking endpoints are known to
-- return attackWins/defenseWins (win *counts*); whether they also return star
-- totals and attempt counts for Ranked mode is not documented. The ingester
-- fills these in when the fields are present and leaves them null when they
-- are not, so nothing downstream breaks either way.

alter table ranking_entries
  add column if not exists offence_stars    integer,
  add column if not exists offence_attacks  integer,
  add column if not exists defence_stars    integer,
  add column if not exists defence_attempts integer;

comment on column ranking_entries.offence_stars is
  'Stars earned attacking during the season. Null when the API does not expose it.';
comment on column ranking_entries.offence_attacks is
  'Attacks used during the season — the denominator of the offence average.';
comment on column ranking_entries.defence_stars is
  'Stars conceded defending during the season.';
comment on column ranking_entries.defence_attempts is
  'Defences faced during the season — the denominator of the defence average.';

-- Rows with stars but no denominator can''t produce an average; the partial
-- index keeps the comparison query off the rest of the table.
create index if not exists ranking_entries_stars_idx
  on ranking_entries (snapshot_id, player_tag)
  where offence_attacks is not null or defence_attempts is not null;

-- ---------------------------------------------------------------------------
-- star_comparison(league, offence_weeks)
--
-- Offence: total stars / total attacks across the last `p_offence_weeks`
-- completed seasons, so a player who used more attacks isn't rewarded for it.
-- Defence: the same ratio for the most recent season alone.
--
-- Only players present in *every* offence week are returned — a player seen in
-- one week of three would otherwise show an average built from a third of the
-- evidence and rank alongside players with full records.
-- ---------------------------------------------------------------------------

create or replace function star_comparison(
  p_league_id     integer,
  p_offence_weeks integer default 3
)
returns table (
  player_tag         text,
  player_name        text,
  clan_tag           text,
  clan_name          text,
  town_hall_level    integer,
  weeks_counted      integer,
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
  with weeks as (
    select id, season_id, captured_at,
           row_number() over (order by captured_at desc) as recency
    from snapshots
    where league_id = p_league_id
      and kind = 'final'
      and complete
    order by captured_at desc
    limit greatest(p_offence_weeks, 1)
  ),
  week_count as (
    select count(*)::int as n from weeks
  ),
  latest as (
    select id from weeks where recency = 1
  ),
  offence as (
    select
      e.player_tag,
      count(*)::int             as weeks_counted,
      sum(e.offence_stars)      as stars,
      sum(e.offence_attacks)    as attacks
    from ranking_entries e
    join weeks w on w.id = e.snapshot_id
    group by e.player_tag
    -- Present in every week we are averaging over.
    having count(*) = (select n from week_count)
       and coalesce(sum(e.offence_attacks), 0) > 0
  ),
  defence as (
    select
      e.player_tag,
      e.player_name,
      e.clan_tag,
      e.clan_name,
      e.town_hall_level,
      e.rank,
      e.trophies,
      e.defence_stars    as stars,
      e.defence_attempts as attempts
    from ranking_entries e
    join latest l on l.id = e.snapshot_id
  )
  select
    o.player_tag,
    d.player_name,
    d.clan_tag,
    d.clan_name,
    d.town_hall_level,
    o.weeks_counted,
    o.stars,
    o.attacks,
    round(o.stars::numeric / nullif(o.attacks, 0), 3)      as offence_avg,
    d.stars,
    d.attempts,
    round(d.stars::numeric / nullif(d.attempts, 0), 3)     as defence_avg,
    d.rank,
    d.trophies
  from offence o
  join defence d on d.player_tag = o.player_tag
  where d.attempts is not null and d.attempts > 0
  order by round(o.stars::numeric / nullif(o.attacks, 0), 3) desc nulls last;
$$;

grant execute on function star_comparison(integer, integer) to anon, authenticated;

-- Cheap probe so the UI can tell "no star data ingested yet" apart from
-- "no players qualified", and say which of the two it is.
create or replace function star_data_available(p_league_id integer)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1
    from ranking_entries e
    join snapshots s on s.id = e.snapshot_id
    where s.league_id = p_league_id
      and (e.offence_attacks is not null or e.defence_attempts is not null)
  );
$$;

grant execute on function star_data_available(integer) to anon, authenticated;

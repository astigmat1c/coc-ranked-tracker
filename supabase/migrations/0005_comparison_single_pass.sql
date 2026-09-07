-- Make the offence/defence comparison survive a real population.
--
-- The first two-week dataset (5,163 + 9,753 rows) blew Supabase's statement
-- timeout on /analysis. The cause was the shape of the query, not the size of
-- the data: performance_comparison built three CTEs — offence, defence and
-- latest — and joined them on player_tag. Postgres cannot estimate the row
-- count of a CTE, so it assumed one row and chose a nested loop:
--
--   Nested Loop (actual rows=4600)
--     Join Filter: (ordered.player_tag = ordered_1.player_tag)
--     Rows Removed by Join Filter: 10577700
--
-- Ten and a half million comparisons to produce 4,600 rows, on a table of
-- 14,916. It would get worse every week.
--
-- The rewrite makes it one grouped pass over player_week_stats. Offence and
-- defence are separated by FILTER clauses on the aggregates rather than by
-- joining two independently-grouped sets, and the per-player descriptive
-- columns come from the same pass instead of a third CTE. There is no join
-- between CTEs left for the planner to get wrong.

-- ---------------------------------------------------------------------------
-- rank on the weekly view
--
-- The old `latest` CTE went back to ranking_entries purely for rank, which is
-- the only column the view did not already carry. Exposing it here is what
-- lets the whole function run off a single relation.
-- ---------------------------------------------------------------------------

create or replace view player_week_stats as
with ordered as (
  select
    e.player_tag,
    s.id                as snapshot_id,
    s.league_id,
    s.season_id,
    s.captured_at,
    e.rank,
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
  end as defence_wins_week,
  -- Appended rather than slotted in beside trophies: CREATE OR REPLACE VIEW
  -- can only add columns at the end, and dropping the view would take its
  -- grants and the security_invoker setting with it.
  rank
from ordered;

alter view player_week_stats set (security_invoker = on);
grant select on player_week_stats to anon, authenticated;

-- ---------------------------------------------------------------------------
-- performance_comparison — same contract, one pass
--
-- A season may appear in both lists (with only one usable week captured, it
-- necessarily does). Such a week is a single row in `weeks` carrying both
-- flags, and the FILTERs count it on both sides, which is correct.
-- ---------------------------------------------------------------------------

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
  with weeks as (
    select
      s.id,
      s.captured_at,
      (s.season_id = any(p_offence_seasons)) as is_off,
      (s.season_id = any(p_defence_seasons)) as is_def
    from snapshots s
    where s.league_id = p_league_id
      and s.complete
      and (s.season_id = any(p_offence_seasons) or s.season_id = any(p_defence_seasons))
  ),
  n as (
    select
      count(*) filter (where is_off)::int as n_off,
      count(*) filter (where is_def)::int as n_def
    from weeks
  )
  select
    w.player_tag,
    -- Descriptive columns are taken from the most recent defence week, which
    -- is what the old `latest` CTE did with DISTINCT ON.
    (array_agg(w.player_name     order by k.captured_at desc) filter (where k.is_def))[1],
    (array_agg(w.clan_tag        order by k.captured_at desc) filter (where k.is_def))[1],
    (array_agg(w.clan_name       order by k.captured_at desc) filter (where k.is_def))[1],
    (array_agg(w.town_hall_level order by k.captured_at desc) filter (where k.is_def))[1],
    count(*) filter (where k.is_off and w.attack_wins_week  is not null)::int,
    count(*) filter (where k.is_def and w.defence_wins_week is not null)::int,
    sum(w.attack_wins_week)  filter (where k.is_off),
    round(
      sum(w.attack_wins_week) filter (where k.is_off)::numeric
        / nullif(count(*) filter (where k.is_off and w.attack_wins_week is not null), 0),
      2),
    sum(w.defence_wins_week) filter (where k.is_def),
    round(
      sum(w.defence_wins_week) filter (where k.is_def)::numeric
        / nullif(count(*) filter (where k.is_def and w.defence_wins_week is not null), 0),
      2),
    (array_agg(w.rank     order by k.captured_at desc) filter (where k.is_def))[1],
    (array_agg(w.trophies order by k.captured_at desc) filter (where k.is_def))[1]
  from player_week_stats w
  join weeks k on k.id = w.snapshot_id
  where (select n_off from n) > 0
    and (select n_def from n) > 0
  group by w.player_tag
  -- Present in every selected week on both sides, with a delta on each.
  having count(*) filter (where k.is_off and w.attack_wins_week  is not null) = (select n_off from n)
     and count(*) filter (where k.is_def and w.defence_wins_week is not null) = (select n_def from n)
  order by
    round(
      sum(w.attack_wins_week) filter (where k.is_off)::numeric
        / nullif(count(*) filter (where k.is_off and w.attack_wins_week is not null), 0),
      2) desc nulls last,
    -- Tiebreaker, and not cosmetic. PostgREST caps a set-returning function at
    -- max-rows (1000 on Supabase) exactly as silently as it caps a table read,
    -- so the caller pages with Range headers — which re-executes the function
    -- per page. Ordering only by the average leaves ties in an arbitrary order
    -- that can differ between executions, which would duplicate some players
    -- across page boundaries and drop others entirely. player_tag is unique
    -- per row here, so this makes the order total.
    w.player_tag;
$$;

grant execute on function performance_comparison(integer, text[], text[]) to anon, authenticated;

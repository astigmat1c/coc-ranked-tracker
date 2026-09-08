-- Offence and defence from polls, in trophies rather than stars.
--
-- WHY NOT STARS
--
-- A player's public record does not update while they are in a session. VI's
-- thirty attacks on 8 September arrived in three lumps — 19, then 8, then 3 —
-- while two defences taken hours earlier arrived one at a time. So the API
-- publishes an attacking session only once it ends, and no polling cadence can
-- see inside one. Nineteen attacks worth 579 trophies is anywhere between 36
-- and 49 stars; that range is too wide to publish, so stars are out.
--
-- WHAT SURVIVES
--
-- Attack batches are identifiable because attackWins moves with them. So the
-- trophy movement splits cleanly:
--
--   windows where attackWins rose      -> attack trophies
--   windows where it did not           -> defence trophies
--
-- and attacks are counted directly. Trophies per attack, on a 0-40 scale where
-- 40 is a three-star, is then exact arithmetic rather than inference. It also
-- says more than a star average: a two-star at 51% pays 16 and one at 99% pays
-- 32, a difference the star count throws away.
--
-- WHAT IS APPROXIMATE, AND BY HOW MUCH
--
--   * A defence landing inside an attack window is counted as attack trophies.
--     Measured on VI: attack trophies read 958 against 947 truly earned — the
--     +11 defence fell in a batch. About 1% at a two-minute cadence.
--   * attackWins counts attacks that SCORED. A zero-star attack does not move
--     it, so `attacks` can undercount and the rating is then slightly flattered.
--   * Defences received are not published anywhere, so defence trophies cannot
--     be divided into a per-defence rate here. That needs the number of
--     defences a week holds, which is a question for the in-game screen.

create or replace view player_poll_windows as
with ordered as (
  select
    player_tag,
    season_id,
    captured_at,
    trophies,
    attack_count,
    defence_count,
    lag(trophies)      over w as prev_trophies,
    lag(attack_count)  over w as prev_attacks,
    lag(defence_count) over w as prev_defences
  from player_polls
  window w as (partition by player_tag, season_id order by captured_at)
)
select
  player_tag,
  season_id,
  captured_at,
  trophies      - prev_trophies  as d_trophies,
  attack_count  - prev_attacks   as d_attacks,
  defence_count - prev_defences  as d_defences
from ordered
where prev_trophies is not null
  -- Counters only ever rise within a season. Anything going backwards is a
  -- reset or a bad read, and describes no battle.
  and trophies      >= prev_trophies
  and attack_count  >= prev_attacks
  and defence_count >= prev_defences;

alter view player_poll_windows set (security_invoker = on);
grant select on player_poll_windows to anon, authenticated;

comment on view player_poll_windows is
  'Consecutive poll differences. One row per interval per player, holding what '
  'changed rather than what was observed.';

create or replace view player_week_ratings as
select
  player_tag,
  season_id,
  sum(d_attacks)::int                                          as attacks,
  sum(d_trophies) filter (where d_attacks > 0)::int             as attack_trophies,
  sum(d_trophies) filter (where d_attacks = 0)::int             as defence_trophies,
  sum(d_trophies)::int                                         as total_trophies,
  -- The offence figure: 0 to 40, where 40 means every attack was a three-star.
  round(
    (sum(d_trophies) filter (where d_attacks > 0))::numeric
      / nullif(sum(d_attacks), 0),
    2)                                                         as trophies_per_attack,
  -- How many separate sittings the attacks arrived in. A low number against a
  -- high attack count is why per-battle detail is unavailable for this player.
  count(*) filter (where d_attacks > 0)                        as attack_batches,
  count(*) filter (where d_attacks = 0 and d_trophies > 0)     as defences_seen,
  min(captured_at)                                             as first_change,
  max(captured_at)                                             as last_change
from player_poll_windows
group by player_tag, season_id;

alter view player_week_ratings set (security_invoker = on);
grant select on player_week_ratings to anon, authenticated;

comment on view player_week_ratings is
  'Per player per ranked week: attacks, trophies earned attacking and '
  'defending, and trophies per attack on a 0-40 scale. Defence trophies are '
  'understated by any defence that landed inside an attack window, and by every '
  'defence conceding three stars, which pays nothing and is invisible.';

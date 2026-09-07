-- High-frequency polling of a small watchlist.
--
-- The weekly sweep answers "who is in Legend II and what did their week total".
-- It cannot answer "how did they earn it", because the API reports one net
-- trophy figure per player and never breaks it down.
--
-- Polling often enough does. A ranked week holds about 59 events per player —
-- 30 attacks and 29 defences — spread across 168 hours, so at a 30-minute
-- cadence the overwhelming majority of windows contain either nothing or a
-- single event. When the attack counter rises by one and the defence counter
-- does not, the trophy change across that window IS that attack.
--
-- And a single battle's trophy movement is a star count, not a proxy for one.
-- Each battle splits a fixed 40 trophies between attacker and defender:
--
--   attacker  3 stars -> 40      defender concedes 3 stars ->  0
--             2 stars -> 20..32                    2 stars -> 8..20
--             1 star  -> below                     1 star  -> 21..32
--             0 stars -> 0                         0 stars -> 40
--
-- So a resolved event classifies directly. Accumulate a week and a player's
-- star distribution and average come out — the figures the in-game Ranked
-- screen shows and the API refuses to.

create table if not exists player_polls (
  player_tag      text        not null,
  captured_at     timestamptz not null,
  season_id       text        not null,
  trophies        integer,
  attack_count    integer,
  defence_count   integer,
  league_tier_id  integer,
  primary key (player_tag, captured_at)
);

comment on table player_polls is
  'Raw observations of a watched player. Rows are consecutive readings; the '
  'meaning is in the differences between them, not in any single row.';

comment on column player_polls.attack_count is
  'attackWins as reported. Whether it counts attacks used or attacks won is '
  'unresolved; polling settles it, because a window with one attack and a '
  'known trophy award identifies which.';

create index if not exists player_polls_series_idx
  on player_polls (player_tag, captured_at);

create index if not exists player_polls_season_idx
  on player_polls (season_id, player_tag);

alter table player_polls enable row level security;

-- Read-only for the site, like every other table here. Writes are the worker's,
-- which uses the service role and bypasses RLS.
drop policy if exists player_polls_read on player_polls;
create policy player_polls_read on player_polls for select to anon, authenticated using (true);

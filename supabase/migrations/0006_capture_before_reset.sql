-- Record how close to the weekly reset a capture was taken.
--
-- attackWins and defenseWins are counters for the current ranked week and they
-- zero at the Monday 05:00 UTC boundary. Live proof, from this database:
--
--   snapshot  captured             rows   zero attacks   avg   max
--   1         Thu 3 Sep 05:49 UTC  5163   3761 (73%)     4.83  31
--   2         Mon 7 Sep 11:47 UTC  9753   9752 (99.99%)  0.00  1
--
-- Snapshot 2 ran under seven hours after a reset and captured an empty week.
-- Snapshot 1 ran mid-week and captured three days of a seven-day week. Neither
-- is a weekly figure, and nothing in the schema could tell them apart from a
-- good one — captured_at alone does not say how much of the week had elapsed.
--
-- So store the distance to the boundary explicitly. A capture taken with
-- minutes to spare is a record of the finished week; one taken with days left
-- is a mid-week reading and must never be presented as a weekly total.

alter table snapshots
  add column if not exists minutes_to_reset integer;

comment on column snapshots.minutes_to_reset is
  'Minutes remaining in the ranked week when this snapshot was captured. '
  'Small means the counters are final; large means mid-week and partial.';

-- Anything captured with more than two hours left is a partial reading of the
-- week. Two hours is generous against a sweep that takes twenty-odd minutes.
create or replace view weekly_snapshots as
select *
from snapshots
where complete
  and kind = 'final'
  and minutes_to_reset is not null
  and minutes_to_reset <= 120;

alter view weekly_snapshots set (security_invoker = on);
grant select on weekly_snapshots to anon, authenticated;

comment on view weekly_snapshots is
  'Snapshots that actually record a finished ranked week. Rows captured after '
  'the reset (empty counters) or mid-week (partial counters) are excluded.';

-- The two existing snapshots predate this column, so they are null and the
-- view excludes them. That is the correct outcome: neither one holds a week.
-- They are left in place rather than deleted so the ranking history and the
-- clan and player tables keep their provenance.

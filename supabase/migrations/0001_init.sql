-- Clash of Clans ranked tracker — core schema
-- Run against your Supabase project (SQL editor, or `supabase db push`).

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Reference data (populated by the discovery pass)
-- ---------------------------------------------------------------------------

create table if not exists leagues (
  id            integer primary key,
  name          text not null,
  -- Parsed from the name where possible: "Legend II" -> family 'Legend', tier 2.
  family        text,
  tier          integer,
  icon_urls     jsonb,
  raw           jsonb,
  updated_at    timestamptz not null default now()
);

create table if not exists locations (
  id            integer primary key,
  name          text not null,
  is_country    boolean not null default false,
  country_code  text,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Slowly-changing dimensions
-- ---------------------------------------------------------------------------

create table if not exists clans (
  tag           text primary key,
  name          text,
  badge_urls    jsonb,
  location_id   integer references locations (id),
  level         integer,
  raw           jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table if not exists players (
  tag               text primary key,
  name              text,
  exp_level         integer,
  town_hall_level   integer,
  clan_tag          text references clans (tag),
  league_id         integer references leagues (id),
  location_id       integer references locations (id),
  raw               jsonb,
  -- Set by the enrichment pass (/players/{tag}); null means "never enriched".
  enriched_at       timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create index if not exists players_name_trgm_idx on players using gin (name gin_trgm_ops);
create index if not exists players_clan_idx      on players (clan_tag);
create index if not exists players_th_idx        on players (town_hall_level);
create index if not exists players_enriched_idx  on players (enriched_at nulls first);

-- ---------------------------------------------------------------------------
-- Facts
-- ---------------------------------------------------------------------------

-- One row per (league, season, capture). `kind` lets the same schema hold both
-- the weekly end-of-season standings and optional mid-season captures, so
-- switching cadence later is a cron change, not a migration.
create table if not exists snapshots (
  id            bigserial primary key,
  league_id     integer not null references leagues (id),
  season_id     text    not null,
  kind          text    not null default 'final' check (kind in ('final', 'interim')),
  captured_at   timestamptz not null default now(),
  season_ends_at timestamptz,
  source        text,
  player_count  integer not null default 0,
  complete      boolean not null default false
);

-- At most one final snapshot per league-season; interim captures are unbounded.
create unique index if not exists snapshots_final_uniq
  on snapshots (league_id, season_id) where kind = 'final';
create index if not exists snapshots_lookup_idx on snapshots (league_id, captured_at desc);

create table if not exists ranking_entries (
  snapshot_id       bigint not null references snapshots (id) on delete cascade,
  player_tag        text   not null,
  rank              integer not null,
  previous_rank     integer,
  trophies          integer,
  attack_wins       integer,
  defense_wins      integer,
  exp_level         integer,
  -- Denormalised so historical rows stay truthful after a rename or clan move.
  player_name       text,
  clan_tag          text,
  clan_name         text,
  town_hall_level   integer,
  raw               jsonb,
  primary key (snapshot_id, player_tag)
);

create index if not exists ranking_entries_rank_idx    on ranking_entries (snapshot_id, rank);
create index if not exists ranking_entries_player_idx  on ranking_entries (player_tag);
create index if not exists ranking_entries_clan_idx    on ranking_entries (snapshot_id, clan_tag);
create index if not exists ranking_entries_trophy_idx  on ranking_entries (snapshot_id, trophies desc);

-- ---------------------------------------------------------------------------
-- Read views
-- ---------------------------------------------------------------------------

-- Flattened leaderboard: what the table view on the site reads.
create or replace view leaderboard as
select
  s.id                                  as snapshot_id,
  s.league_id,
  s.season_id,
  s.kind,
  s.captured_at,
  l.name                                as league_name,
  e.player_tag,
  coalesce(e.player_name, p.name)       as player_name,
  e.rank,
  e.previous_rank,
  (e.previous_rank - e.rank)            as rank_delta,
  e.trophies,
  e.attack_wins,
  e.defense_wins,
  e.exp_level,
  coalesce(e.town_hall_level, p.town_hall_level) as town_hall_level,
  e.clan_tag,
  coalesce(e.clan_name, c.name)         as clan_name,
  c.location_id                         as clan_location_id,
  loc.name                              as clan_location_name,
  loc.country_code                      as clan_country_code
from ranking_entries e
join snapshots s on s.id = e.snapshot_id
join leagues   l on l.id = s.league_id
left join players   p   on p.tag = e.player_tag
left join clans     c   on c.tag = e.clan_tag
left join locations loc on loc.id = c.location_id;

-- Per-player season-over-season series: what the history chart reads.
create or replace view player_history as
select
  e.player_tag,
  s.league_id,
  l.name        as league_name,
  s.season_id,
  s.kind,
  s.captured_at,
  e.rank,
  e.trophies,
  e.attack_wins,
  e.defense_wins,
  e.clan_tag,
  e.clan_name
from ranking_entries e
join snapshots s on s.id = e.snapshot_id
join leagues   l on l.id = s.league_id
order by e.player_tag, s.captured_at;

-- By default a view runs with its owner's rights, which would quietly bypass
-- the policies below. security_invoker makes both views honour the caller's
-- RLS instead — the same select-only access the base tables grant.
alter view leaderboard    set (security_invoker = on);
alter view player_history set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Row level security: the site reads with the anon key, the worker writes with
-- the service-role key (which bypasses RLS entirely).
-- ---------------------------------------------------------------------------

alter table leagues        enable row level security;
alter table locations      enable row level security;
alter table clans          enable row level security;
alter table players        enable row level security;
alter table snapshots      enable row level security;
alter table ranking_entries enable row level security;

do $$
declare t text;
begin
  foreach t in array array['leagues','locations','clans','players','snapshots','ranking_entries']
  loop
    execute format(
      'drop policy if exists %I on %I', 'public_read_' || t, t
    );
    execute format(
      'create policy %I on %I for select to anon, authenticated using (true)',
      'public_read_' || t, t
    );
  end loop;
end $$;

-- Supabase's default privileges normally cover this; granting explicitly keeps
-- the migration self-contained if it is ever run against a plain Postgres.
grant usage on schema public to anon, authenticated;
grant select on
  leagues, locations, clans, players, snapshots, ranking_entries,
  leaderboard, player_history
  to anon, authenticated;

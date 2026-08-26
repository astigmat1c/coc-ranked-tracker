import FilterBar from '@/components/FilterBar';
import LeaderboardTable from '@/components/LeaderboardTable';
import Pagination from '@/components/Pagination';
import {
  DEFAULT_PAGE_SIZE,
  getCountriesInSeason,
  getLatestSnapshot,
  getLeaderboard,
  getSeasons,
  getTrackedLeagues,
} from '@/lib/queries';

export const revalidate = 300;

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const num = (v: string | string[] | undefined) => {
  const n = Number(one(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export default async function RankingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;

  const leagues = await getTrackedLeagues();

  if (leagues.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
        <h1 className="text-lg font-semibold">No data yet</h1>
        <p className="mt-2 max-w-prose text-sm text-[var(--text-secondary)]">
          Nothing has been ingested. Run <code>npm run discover</code> to see which league IDs the
          API exposes, then <code>npm run ingest</code> to capture a season.
        </p>
      </div>
    );
  }

  // Fall back to whichever league has the most recent capture.
  const latest = await getLatestSnapshot();
  const leagueId = num(sp.league) ?? latest?.league_id ?? leagues[0].id;

  const seasons = await getSeasons(leagueId);
  const seasonId = one(sp.season) ?? seasons[0]?.season_id;

  if (!seasonId) {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        No completed seasons stored for this league yet.
      </p>
    );
  }

  const page = num(sp.page) ?? 1;
  const countries = await getCountriesInSeason(leagueId, seasonId);

  const { rows, total } = await getLeaderboard({
    leagueId,
    seasonId,
    search: one(sp.search),
    clan: one(sp.clan),
    countryCode: one(sp.country),
    townHall: num(sp.th),
    minTrophies: num(sp.minTrophies),
    maxTrophies: num(sp.maxTrophies),
    sort: one(sp.sort),
    dir: one(sp.dir) === 'desc' ? 'desc' : 'asc',
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const league = leagues.find((l) => l.id === leagueId);
  const snapshot = seasons.find((s) => s.season_id === seasonId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {league?.name ?? `League ${leagueId}`} · {seasonId}
        </h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {snapshot
            ? `${snapshot.player_count.toLocaleString()} players · captured ${new Date(
                snapshot.captured_at,
              ).toLocaleString()}`
            : null}
        </p>
      </div>

      <FilterBar
        leagues={leagues}
        seasons={seasons}
        countries={countries}
      />

      {rows.length === 0 ? (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
          No players match these filters.
        </p>
      ) : (
        <>
          <LeaderboardTable rows={rows} />
          <Pagination
            page={page}
            pageSize={DEFAULT_PAGE_SIZE}
            total={total}
            params={{
              league: String(leagueId),
              season: seasonId,
              search: one(sp.search),
              clan: one(sp.clan),
              country: one(sp.country),
              th: one(sp.th),
              minTrophies: one(sp.minTrophies),
              maxTrophies: one(sp.maxTrophies),
              sort: one(sp.sort),
              dir: one(sp.dir),
            }}
          />
        </>
      )}
    </div>
  );
}

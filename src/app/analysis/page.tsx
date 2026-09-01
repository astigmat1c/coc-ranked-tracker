import Link from 'next/link';
import StarComparison from '@/components/StarComparison';
import { toStarTuple } from '@/lib/types';
import {
  getSeasons,
  getStarComparison,
  getTrackedLeagues,
  hasStarData,
} from '@/lib/queries';

export const revalidate = 300;

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The page exists for Legend II, so that's what it opens on when present. */
const LEGEND_II = /legend\s*(ii|2)\b/i;

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-2 max-w-prose space-y-2 text-sm text-[var(--text-secondary)]">
        {children}
      </div>
    </div>
  );
}

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const weeks = Math.min(Math.max(Number(one(sp.weeks) ?? 3) || 3, 1), 12);

  const leagues = await getTrackedLeagues();
  if (leagues.length === 0) {
    return (
      <Notice title="No data yet">
        <p>
          Nothing has been ingested. Run <code>npm run discover</code>, then{' '}
          <code>npm run ingest -- --backfill 4</code> to capture enough weeks for this
          comparison.
        </p>
      </Notice>
    );
  }

  const requested = Number(one(sp.league));
  const league =
    leagues.find((l) => l.id === requested) ??
    leagues.find((l) => LEGEND_II.test(l.name)) ??
    leagues[0];

  const seasons = await getSeasons(league.id);

  if (seasons.length < weeks) {
    return (
      <Notice title="Not enough weeks captured yet">
        <p>
          This comparison averages offence over {weeks} weeks, but only{' '}
          {seasons.length} completed {seasons.length === 1 ? 'season is' : 'seasons are'} stored
          for {league.name}.
        </p>
        <p>
          Run <code>npm run ingest -- --backfill {weeks}</code> to pull the earlier weeks, if
          the API still serves them.
        </p>
      </Notice>
    );
  }

  const [rows, starsExist] = await Promise.all([
    getStarComparison(league.id, weeks),
    hasStarData(league.id),
  ]);

  const offenceSeasons = seasons.slice(0, weeks).map((s) => s.season_id).reverse();
  const defenceSeason = seasons[0]?.season_id ?? null;

  if (!starsExist) {
    return (
      <Notice title="No star data in the captured seasons">
        <p>
          {league.name} has {seasons.length} seasons stored, but none of their rows carried star
          totals or attempt counts — so an average like 2.69 can&apos;t be computed. Win counts
          alone can&apos;t produce one.
        </p>
        <p>
          Check <code>worker/discovery/</code> for the field names the API actually returns. If
          stars are in there under names the ingester doesn&apos;t recognise, add them to the
          candidate lists in <code>worker/src/stars.ts</code> and re-run{' '}
          <code>npm run ingest -- --force</code>. The ingest log prints which names it matched on
          every run.
        </p>
      </Notice>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Offence vs defence</h1>
        <p className="mt-1 max-w-prose text-sm text-[var(--text-muted)]">
          {league.name} · offence averaged over {weeks} weeks, defence over the latest week.
          Only players who appeared in all {weeks} weeks are included, so nobody&apos;s average
          rests on a partial record.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[var(--text-muted)]">Offence window:</span>
        {[2, 3, 4, 6].map((w) => (
          <Link
            key={w}
            href={`/analysis?league=${league.id}&weeks=${w}`}
            className={`rounded-md border px-3 py-1 ${
              w === weeks
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {w} weeks
          </Link>
        ))}
        {leagues.length > 1 && (
          <>
            <span className="ml-4 text-[var(--text-muted)]">League:</span>
            {leagues.map((l) => (
              <Link
                key={l.id}
                href={`/analysis?league=${l.id}&weeks=${weeks}`}
                className={`rounded-md border px-3 py-1 ${
                  l.id === league.id
                    ? 'border-[var(--accent)] text-[var(--text-primary)]'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {l.name}
              </Link>
            ))}
          </>
        )}
      </div>

      {rows.length === 0 ? (
        <Notice title="No players qualified">
          <p>
            Star data exists for {league.name}, but no player appeared in all {weeks} captured
            weeks with both attacks and defences recorded. Try a shorter offence window.
          </p>
        </Notice>
      ) : (
        <StarComparison
          rows={rows.map(toStarTuple)}
          weeks={weeks}
          leagueName={league.name}
          offenceSeasons={offenceSeasons}
          defenceSeason={defenceSeason}
        />
      )}
    </div>
  );
}

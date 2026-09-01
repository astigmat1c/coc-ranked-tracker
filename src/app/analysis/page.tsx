import Link from 'next/link';
import StarComparison from '@/components/StarComparison';
import WeekPicker from '@/components/WeekPicker';
import { toStarTuple } from '@/lib/types';
import { weekLabel } from '@/lib/weeks';
import { getSeasons, getStarComparison, getTrackedLeagues, hasStarData } from '@/lib/queries';

export const revalidate = 300;

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const list = (v: string | string[] | undefined): string[] =>
  (one(v) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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
  if (seasons.length === 0) {
    return (
      <Notice title="No completed weeks stored">
        <p>
          No finished season has been captured for {league.name} yet. Run{' '}
          <code>npm run ingest</code>.
        </p>
      </Notice>
    );
  }

  // getSeasons returns newest-first.
  const valid = new Set(seasons.map((s) => s.season_id));
  const defaultOffence = seasons.slice(0, 3).map((s) => s.season_id).reverse();
  const defaultDefence = [seasons[0].season_id];

  // Unknown ids in a bookmarked or hand-edited URL are dropped rather than
  // failing the page; an empty result after filtering falls back to defaults.
  const pickedOffence = list(sp.off).filter((s) => valid.has(s));
  const pickedDefence = list(sp.def).filter((s) => valid.has(s));
  const offence = pickedOffence.length > 0 ? pickedOffence : defaultOffence;
  const defence = pickedDefence.length > 0 ? pickedDefence : defaultDefence;

  const [rows, starsExist] = await Promise.all([
    getStarComparison(league.id, offence, defence),
    hasStarData(league.id),
  ]);

  const byId = new Map(seasons.map((s) => [s.season_id, s]));
  const labelsFor = (ids: string[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at))
      .map(weekLabel);

  const picker = (
    <WeekPicker
      leagueId={league.id}
      seasons={seasons}
      offence={offence}
      defence={defence}
      defaultOffence={defaultOffence}
      defaultDefence={defaultDefence}
    />
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Offence vs defence</h1>
        <p className="mt-1 max-w-prose text-sm text-[var(--text-muted)]">
          {league.name} · pick any weeks for each side — they don&apos;t have to be adjacent.
          Only players who appeared in every week you select, on both sides, are included, so
          no average rests on a partial record.
        </p>
      </div>

      {leagues.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--text-muted)]">League:</span>
          {leagues.map((l) => (
            <Link
              key={l.id}
              href={`/analysis?league=${l.id}`}
              className={`rounded-md border px-3 py-1 ${
                l.id === league.id
                  ? 'border-[var(--accent)] text-[var(--text-primary)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {l.name}
            </Link>
          ))}
        </div>
      )}

      {picker}

      {!starsExist ? (
        <Notice title="No star data in the captured seasons">
          <p>
            {league.name} has {seasons.length} {seasons.length === 1 ? 'season' : 'seasons'}{' '}
            stored, but none of their rows carried star totals or attempt counts — so an average
            like 2.69 can&apos;t be computed. Win counts alone can&apos;t produce one.
          </p>
          <p>
            Check <code>worker/discovery/</code> for the field names the API actually returns. If
            stars are in there under names the ingester doesn&apos;t recognise, add them to the
            candidate lists in <code>worker/src/stars.ts</code> and re-run{' '}
            <code>npm run ingest -- --force</code>. The ingest log prints which names it matched
            on every run.
          </p>
        </Notice>
      ) : rows.length === 0 ? (
        <Notice title="No players qualified for this selection">
          <p>
            Star data exists for {league.name}, but no player appeared in all{' '}
            {offence.length + defence.length} selected weeks with both attacks and defences
            recorded. Narrowing the selection to fewer weeks will usually bring players back.
          </p>
        </Notice>
      ) : (
        <StarComparison
          rows={rows.map(toStarTuple)}
          leagueName={league.name}
          offenceLabels={labelsFor(offence)}
          defenceLabels={labelsFor(defence)}
        />
      )}
    </div>
  );
}

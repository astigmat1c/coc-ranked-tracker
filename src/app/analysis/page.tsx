import Link from 'next/link';
import ComparisonView from '@/components/ComparisonView';
import WeekPicker from '@/components/WeekPicker';
import { toComparisonTuple } from '@/lib/types';
import { weekLabel } from '@/lib/weeks';
import { getComparison, getSeasons, getTrackedLeagues, hasComparisonData } from '@/lib/queries';

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

  // getSeasons returns newest-first. The earliest snapshot has no predecessor,
  // so it has no week-over-week delta and can never contribute to either side —
  // it is excluded from the picker rather than offered as a choice that always
  // yields nothing.
  const usable = seasons.slice(0, -1);
  if (usable.length === 0) {
    return (
      <Notice title="Only one week captured so far">
        <p>
          Offence and defence figures are the change between consecutive weekly snapshots,
          so {league.name} needs a second capture before this page has anything to show.
        </p>
      </Notice>
    );
  }

  const valid = new Set(usable.map((s) => s.season_id));
  const defaultOffence = usable.slice(0, 3).map((s) => s.season_id).reverse();
  const defaultDefence = [usable[0].season_id];

  // Unknown ids in a bookmarked or hand-edited URL are dropped rather than
  // failing the page; an empty result after filtering falls back to defaults.
  const pickedOffence = list(sp.off).filter((s) => valid.has(s));
  const pickedDefence = list(sp.def).filter((s) => valid.has(s));
  const offence = pickedOffence.length > 0 ? pickedOffence : defaultOffence;
  const defence = pickedDefence.length > 0 ? pickedDefence : defaultDefence;

  const [rows, comparable] = await Promise.all([
    getComparison(league.id, offence, defence),
    hasComparisonData(league.id),
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
      seasons={usable}
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
          {league.name} · attack wins against defence wins, per week. Pick any weeks for
          each side — they don&apos;t have to be adjacent. Only players present in every week
          you select, on both sides, are included, so no average rests on a partial record.
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

      {!comparable ? (
        <Notice title="Only one week captured so far">
          <p>
            Offence and defence figures are the change between consecutive weekly
            snapshots, so {league.name} needs at least two before this page has anything
            to show. One more weekly run and it fills in.
          </p>
          <p>
            Worth setting expectations: these are attack and defence <em>wins</em>, not
            stars. Nothing in Supercell&apos;s API carries star totals or attempt counts —
            not the player record, not the league tier, not any ranking row — so an average
            like 2.69 stars per attack cannot be computed from it at all.
          </p>
        </Notice>
      ) : rows.length === 0 ? (
        <Notice title="No players qualified for this selection">
          <p>
            No player appeared in all {offence.length + defence.length} selected weeks with
            both attack and defence counts recorded. Narrowing the selection to fewer weeks
            will usually bring players back.
          </p>
        </Notice>
      ) : (
        <ComparisonView
          rows={rows.map(toComparisonTuple)}
          leagueName={league.name}
          offenceLabels={labelsFor(offence)}
          defenceLabels={labelsFor(defence)}
        />
      )}
    </div>
  );
}

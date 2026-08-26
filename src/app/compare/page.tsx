import Link from 'next/link';
import HistoryChart, { type Series } from '@/components/HistoryChart';
import { getPlayer, getPlayerHistory } from '@/lib/queries';

export const revalidate = 300;

/** Matches the categorical slot count the chart palette validates for. */
const MAX_SERIES = 5;

type Search = Record<string, string | string[] | undefined>;

export default async function ComparePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.tags) ? sp.tags[0] : sp.tags;

  const tags = (raw ?? '')
    .split(',')
    .map((t) => decodeURIComponent(t).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_SERIES);

  if (tags.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
        <h1 className="text-lg font-semibold">Compare players</h1>
        <p className="mt-2 max-w-prose text-sm text-[var(--text-secondary)]">
          Pick up to {MAX_SERIES} players with the checkboxes on the{' '}
          <Link href="/rankings" className="text-[var(--accent)] hover:underline">
            rankings table
          </Link>
          , then hit Compare. You can also link straight here with{' '}
          <code>/compare?tags=%23ABC,%23DEF</code>.
        </p>
      </div>
    );
  }

  const series: Series[] = await Promise.all(
    tags.map(async (tag) => {
      const [player, rows] = await Promise.all([getPlayer(tag), getPlayerHistory(tag)]);
      return { tag, name: player?.name ?? rows.at(-1)?.clan_name ?? tag, rows };
    }),
  );

  const withData = series.filter((s) => s.rows.length > 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Head to head</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {withData.length} of {series.length} players have stored season history.
        </p>
      </div>

      {withData.length === 0 ? (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
          None of these tags have any captured seasons yet.
        </p>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <HistoryChart series={withData} metric="trophies" title="Trophies by season" />
            <HistoryChart series={withData} metric="rank" title="Rank by season" />
          </div>

          {/* Table view: the numbers behind both charts, side by side. */}
          <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="px-3 pt-3 text-left text-sm font-semibold">Summary</caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2 text-right">Seasons</th>
                  <th className="px-3 py-2 text-right">Best rank</th>
                  <th className="px-3 py-2 text-right">Peak trophies</th>
                  <th className="px-3 py-2 text-right">Latest rank</th>
                </tr>
              </thead>
              <tbody>
                {withData.map((s) => {
                  const best = Math.min(...s.rows.map((r) => r.rank));
                  const peak = Math.max(...s.rows.map((r) => r.trophies ?? 0));
                  const latest = s.rows.at(-1);
                  return (
                    <tr key={s.tag} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2">
                        <Link
                          href={`/player/${encodeURIComponent(s.tag)}`}
                          className="font-medium hover:underline"
                        >
                          {s.name}
                        </Link>
                        <span className="ml-2 text-xs text-[var(--text-muted)]">{s.tag}</span>
                      </td>
                      <td className="tabular px-3 py-2 text-right">{s.rows.length}</td>
                      <td className="tabular px-3 py-2 text-right">#{best}</td>
                      <td className="tabular px-3 py-2 text-right">
                        {peak ? peak.toLocaleString() : '—'}
                      </td>
                      <td className="tabular px-3 py-2 text-right">
                        {latest ? `#${latest.rank}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

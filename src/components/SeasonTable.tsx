import type { PlayerHistoryRow } from '@/lib/types';

/**
 * The table view. Also the accessibility relief for the light-mode chart
 * palette, where three categorical slots sit below 3:1 against the surface.
 */
export default function SeasonTable({ rows }: { rows: PlayerHistoryRow[] }) {
  if (rows.length === 0) return null;

  // Newest first reads better in a table, even though the chart runs forward.
  const ordered = [...rows].sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="px-3 pt-3 text-left text-sm font-semibold">Season by season</caption>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            <th className="px-3 py-2">Season</th>
            <th className="px-3 py-2">League</th>
            <th className="px-3 py-2 text-right">Rank</th>
            <th className="px-3 py-2 text-right">Trophies</th>
            <th className="px-3 py-2 text-right">Att</th>
            <th className="px-3 py-2 text-right">Def</th>
            <th className="px-3 py-2">Clan</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr
              key={`${r.league_id}-${r.season_id}-${r.captured_at}`}
              className="border-b border-[var(--border)] last:border-0"
            >
              <td className="tabular px-3 py-2">{r.season_id}</td>
              <td className="px-3 py-2 text-[var(--text-secondary)]">{r.league_name}</td>
              <td className="tabular px-3 py-2 text-right font-medium">#{r.rank}</td>
              <td className="tabular px-3 py-2 text-right">{r.trophies?.toLocaleString() ?? '—'}</td>
              <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">
                {r.attack_wins ?? '—'}
              </td>
              <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">
                {r.defense_wins ?? '—'}
              </td>
              <td className="px-3 py-2 text-[var(--text-secondary)]">{r.clan_name ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { LeaderboardRow } from '@/lib/types';

const COLUMNS: { key: string; label: string; numeric?: boolean; sortable?: boolean }[] = [
  { key: 'rank', label: '#', numeric: true, sortable: true },
  { key: 'player_name', label: 'Player', sortable: true },
  { key: 'town_hall_level', label: 'TH', numeric: true, sortable: true },
  { key: 'clan_name', label: 'Clan', sortable: true },
  { key: 'clan_location_name', label: 'Country' },
  { key: 'trophies', label: 'Trophies', numeric: true, sortable: true },
  { key: 'attack_wins', label: 'Att', numeric: true, sortable: true },
  { key: 'defense_wins', label: 'Def', numeric: true, sortable: true },
  { key: 'rank_delta', label: 'Move', numeric: true, sortable: true },
];

/** Rank movement: positive delta means the player climbed. */
function RankDelta({ value }: { value: number | null }) {
  if (value === null || value === 0) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }
  const up = value > 0;
  return (
    <span
      className="tabular font-medium"
      style={{ color: up ? 'var(--good)' : 'var(--critical)' }}
      title={up ? `Up ${value} places` : `Down ${Math.abs(value)} places`}
    >
      {up ? '▲' : '▼'} {Math.abs(value)}
    </span>
  );
}

export default function LeaderboardTable({ rows }: { rows: LeaderboardRow[] }) {
  const params = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);

  const currentSort = params.get('sort') ?? 'rank';
  const currentDir = params.get('dir') ?? 'asc';

  const sortHref = (key: string) => {
    const next = new URLSearchParams(params.toString());
    const dir = currentSort === key && currentDir === 'asc' ? 'desc' : 'asc';
    next.set('sort', key);
    next.set('dir', dir);
    next.delete('page');
    return `/rankings?${next.toString()}`;
  };

  const toggle = (tag: string) =>
    setSelected((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : prev.length >= 5 ? prev : [...prev, tag],
    );

  return (
    <>
      {selected.length > 0 && (
        <div className="sticky top-0 z-10 mb-2 flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm">
          <span className="text-[var(--text-secondary)]">
            {selected.length} selected{selected.length >= 5 && ' (max)'}
          </span>
          <Link
            href={`/compare?tags=${selected.map(encodeURIComponent).join(',')}`}
            className="rounded-md bg-[var(--accent)] px-3 py-1 font-medium text-white"
          >
            Compare
          </Link>
          <button
            type="button"
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() => setSelected([])}
          >
            Clear
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
              <th className="w-8 px-3 py-2" aria-label="Select for comparison" />
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2 text-[11px] font-medium uppercase tracking-wide ${
                    c.numeric ? 'text-right' : ''
                  }`}
                >
                  {c.sortable ? (
                    <Link
                      href={sortHref(c.key)}
                      className="hover:text-[var(--text-primary)]"
                      aria-sort={
                        currentSort === c.key
                          ? currentDir === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      {c.label}
                      {currentSort === c.key && (currentDir === 'asc' ? ' ↑' : ' ↓')}
                    </Link>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.player_tag}
                className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-raised)]"
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Compare ${r.player_name ?? r.player_tag}`}
                    checked={selected.includes(r.player_tag)}
                    onChange={() => toggle(r.player_tag)}
                  />
                </td>
                <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">
                  {r.rank}
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/player/${encodeURIComponent(r.player_tag)}`}
                    className="font-medium hover:underline"
                  >
                    {r.player_name ?? r.player_tag}
                  </Link>
                  <span className="ml-2 text-xs text-[var(--text-muted)]">{r.player_tag}</span>
                </td>
                <td className="tabular px-3 py-2 text-right">
                  {r.town_hall_level ?? <span className="text-[var(--text-muted)]">—</span>}
                </td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">
                  {r.clan_name ?? <span className="text-[var(--text-muted)]">No clan</span>}
                </td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">
                  {r.clan_location_name ?? <span className="text-[var(--text-muted)]">—</span>}
                </td>
                <td className="tabular px-3 py-2 text-right font-medium">{r.trophies ?? '—'}</td>
                <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">
                  {r.attack_wins ?? '—'}
                </td>
                <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">
                  {r.defense_wins ?? '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <RankDelta value={r.rank_delta} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

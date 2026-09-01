'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { fromStarTuple, type StarPoint, type StarTuple } from '@/lib/types';

/**
 * One population, so one colour — slot 1. A searched player is promoted to
 * slot 2 and drawn on top; that is emphasis, not a second category, and it is
 * the only reason a second hue appears here.
 */
const BASE = 'var(--series-1)';
const HIGHLIGHT = 'var(--series-2)';

/** Stars per attack can't exceed 3, so both axes share a fixed, honest scale. */
const AXIS_DOMAIN: [number, number] = [0, 3];

type SortKey =
  | 'offence_avg'
  | 'defence_avg'
  | 'gap'
  | 'player_name'
  | 'clan_name'
  | 'town_hall_level'
  | 'latest_rank';

type Point = StarPoint;

/**
 * One plotted mark, standing for every player sharing an exact coordinate.
 *
 * Averages here are stars divided by a fixed attack allowance, so they take a
 * limited set of values and thousands of players land on the same lattice
 * points. Plotted one dot per player they overprint exactly, and opacity can't
 * tell one player from two hundred. Binning and sizing the mark by `count`
 * puts that density back on the page — and drops the rendered mark count from
 * ~10k to a few hundred.
 */
interface Bin {
  x: number;
  y: number;
  count: number;
  /** A few members, for the tooltip. Not the full list — that would undo the saving. */
  sample: Point[];
}

function binPoints(points: Point[]): Bin[] {
  const bins = new Map<string, Bin>();

  for (const p of points) {
    if (p.offence_avg === null || p.defence_avg === null) continue;
    const key = `${p.offence_avg}|${p.defence_avg}`;
    const bin = bins.get(key);
    if (bin) {
      bin.count++;
      if (bin.sample.length < 5) bin.sample.push(p);
    } else {
      bins.set(key, { x: p.offence_avg, y: p.defence_avg, count: 1, sample: [p] });
    }
  }

  // Biggest bins first so the small ones paint on top and stay clickable.
  return [...bins.values()].sort((a, b) => b.count - a.count);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <dt className="min-w-24">{label}</dt>
      <dd className="ml-auto font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

function ScatterTooltip({ active, payload }: { active?: boolean; payload?: { payload: Bin }[] }) {
  const bin = payload?.[0]?.payload;
  if (!active || !bin) return null;

  const lead = bin.sample[0];

  return (
    <div className="max-w-64 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-xs shadow-lg">
      {bin.count === 1 && lead ? (
        <>
          <p className="font-medium text-[var(--text-primary)]">
            {lead.player_name ?? lead.player_tag}
          </p>
          <p className="text-[var(--text-muted)]">
            {lead.clan_name ?? 'No clan'}
            {lead.town_hall_level ? ` · TH${lead.town_hall_level}` : ''}
          </p>
        </>
      ) : (
        <>
          <p className="font-medium text-[var(--text-primary)]">
            {bin.count.toLocaleString()} players here
          </p>
          <p className="text-[var(--text-muted)]">
            {bin.sample.map((p) => p.player_name ?? p.player_tag).join(', ')}
            {bin.count > bin.sample.length && ` +${(bin.count - bin.sample.length).toLocaleString()} more`}
          </p>
        </>
      )}
      <dl className="tabular mt-1.5 space-y-0.5 text-[var(--text-secondary)]">
        <Row label="Offence avg" value={`${bin.x.toFixed(2)} ★`} />
        <Row label="Defence avg" value={`${bin.y.toFixed(2)} ★`} />
      </dl>
      {bin.count > 1 && (
        <p className="mt-1.5 text-[var(--text-muted)]">Search a name to pick one out.</p>
      )}
    </div>
  );
}

export default function StarComparison({
  rows,
  weeks,
  leagueName,
  offenceSeasons,
  defenceSeason,
}: {
  rows: StarTuple[];
  weeks: number;
  leagueName: string;
  offenceSeasons: string[];
  defenceSeason: string | null;
}) {
  const [search, setSearch] = useState('');
  const [townHall, setTownHall] = useState('');
  const [sort, setSort] = useState<SortKey>('offence_avg');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState(100);

  // Decoded once; the wire format is positional to keep the payload small.
  const points: Point[] = useMemo(() => rows.map(fromStarTuple), [rows]);

  const townHalls = useMemo(
    () =>
      [...new Set(points.map((p) => p.town_hall_level).filter((t): t is number => t !== null))].sort(
        (a, b) => b - a,
      ),
    [points],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return points.filter((p) => {
      if (townHall && String(p.town_hall_level) !== townHall) return false;
      if (!term) return true;
      return (
        p.player_name?.toLowerCase().includes(term) ||
        p.player_tag.toLowerCase().includes(term) ||
        p.clan_name?.toLowerCase().includes(term)
      );
    });
  }, [points, search, townHall]);

  // With a search active the matches are drawn on top in the highlight hue and
  // everything else recedes, rather than the rest vanishing — the population
  // is the context that makes one player's position mean anything.
  const searching = search.trim().length > 0 || townHall !== '';
  const matchTags = useMemo(() => new Set(filtered.map((p) => p.player_tag)), [filtered]);
  const background = useMemo(
    () => binPoints(searching ? points.filter((p) => !matchTags.has(p.player_tag)) : points),
    [points, matchTags, searching],
  );
  const foreground = useMemo(() => (searching ? binPoints(filtered) : []), [filtered, searching]);

  // Translucency still helps where neighbouring bins overlap, but a handful of
  // marks just looks washed out, so the fill firms up as the population shrinks.
  const baseOpacity = searching ? 0.22 : points.length > 400 ? 0.6 : 0.85;

  // Mark area scales with bin population. Capped so one enormous bin can't
  // swallow the plot, and floored so a single player is still ~9px.
  const maxCount = useMemo(
    () => Math.max(1, ...background.map((b) => b.count), ...foreground.map((b) => b.count)),
    [background, foreground],
  );

  const sorted = useMemo(() => {
    const factor = dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string' && typeof bv === 'string') return factor * av.localeCompare(bv);
      return factor * (Number(av) - Number(bv));
    });
  }, [filtered, sort, dir]);

  const setSorting = (key: SortKey) => {
    if (key === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDir(key === 'player_name' || key === 'clan_name' ? 'asc' : 'desc');
    }
  };

  const field =
    'h-9 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 text-sm ' +
    'text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  const columns: { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: 'latest_rank', label: 'Rank', numeric: true },
    { key: 'player_name', label: 'Player' },
    { key: 'town_hall_level', label: 'TH', numeric: true },
    { key: 'clan_name', label: 'Clan' },
    { key: 'offence_avg', label: `Offence ★ (${weeks}w)`, numeric: true },
    { key: 'defence_avg', label: 'Defence ★ (1w)', numeric: true },
    { key: 'gap', label: 'Gap', numeric: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <div>
          <label
            className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
            htmlFor="star-search"
          >
            Player or clan
          </label>
          <input
            id="star-search"
            className={`${field} w-56`}
            placeholder="name, #TAG, or clan"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label
            className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
            htmlFor="star-th"
          >
            Town Hall
          </label>
          <select
            id="star-th"
            className={field}
            value={townHall}
            onChange={(e) => setTownHall(e.target.value)}
          >
            <option value="">All</option>
            {townHalls.map((t) => (
              <option key={t} value={t}>
                TH{t}
              </option>
            ))}
          </select>
        </div>
        <p className="tabular ml-auto text-sm text-[var(--text-muted)]">
          {filtered.length.toLocaleString()} of {points.length.toLocaleString()} players
        </p>
      </div>

      <figure className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <figcaption className="text-sm font-semibold text-[var(--text-primary)]">
          Offence vs defence, {leagueName}
        </figcaption>
        <p className="mb-3 max-w-prose text-xs text-[var(--text-muted)]">
          Dot size is how many players share that exact pair of averages — everyone gets the
          same attack allowance, so thousands land on identical values. Horizontal: average
          stars per attack across{' '}
          {offenceSeasons.length > 0 ? offenceSeasons.join(', ') : `the last ${weeks} weeks`}.
          Vertical: average stars conceded per defence in{' '}
          {defenceSeason ?? 'the latest week'}. The diagonal is parity — above it a player
          concedes more than they take, below it they take more than they concede.
        </p>

        {/* Size key — mark area carries magnitude, so it needs a scale the
            reader can calibrate against, the same way a colour ramp would. */}
        {maxCount > 1 && (
          <div className="mb-2 flex items-center gap-3 text-xs text-[var(--text-muted)]">
            <span>Players per point:</span>
            {[1, Math.round(maxCount / 2), maxCount]
              .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
              .map((v) => {
                // Match the ZAxis area mapping so the key is literally to scale.
                const area = 56 + ((v - 1) / Math.max(1, maxCount - 1)) * (420 - 56);
                const d = 2 * Math.sqrt(area / Math.PI);
                return (
                  <span key={v} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      style={{
                        width: d,
                        height: d,
                        background: BASE,
                        opacity: 0.6,
                        borderRadius: '9999px',
                        display: 'inline-block',
                      }}
                    />
                    <span className="tabular">{v.toLocaleString()}</span>
                  </span>
                );
              })}
          </div>
        )}

        <div className="h-[420px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 20, bottom: 28, left: 4 }}>
              <CartesianGrid stroke="var(--grid)" />
              <XAxis
                type="number"
                dataKey="x"
                name="Offence"
                domain={AXIS_DOMAIN}
                ticks={[0, 0.5, 1, 1.5, 2, 2.5, 3]}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--axis)' }}
                label={{
                  value: `Offence — avg stars per attack (${weeks} weeks)`,
                  position: 'insideBottom',
                  offset: -18,
                  fill: 'var(--text-secondary)',
                  fontSize: 11,
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Defence"
                domain={AXIS_DOMAIN}
                ticks={[0, 0.5, 1, 1.5, 2, 2.5, 3]}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={64}
                label={{
                  value: 'Defence — avg stars conceded',
                  angle: -90,
                  position: 'insideLeft',
                  fill: 'var(--text-secondary)',
                  fontSize: 11,
                  style: { textAnchor: 'middle' },
                }}
              />
              {/* Recharts sizes scatter marks by area, so area ∝ player count
                  is exactly the right encoding for a bin. */}
              <ZAxis type="number" dataKey="count" domain={[1, maxCount]} range={[56, 420]} />

              {/* Parity: offence average equals defence average. Solid hairline —
                  a dashed rule would read as a threshold or a projection. */}
              <ReferenceLine
                segment={[
                  { x: 0, y: 0 },
                  { x: 3, y: 3 },
                ]}
                stroke="var(--axis)"
                strokeWidth={1}
                ifOverflow="extendDomain"
              />

              <Tooltip
                cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
                content={<ScatterTooltip />}
              />

              <Scatter
                data={background}
                fill={BASE}
                fillOpacity={baseOpacity}
                isAnimationActive={false}
              />
              {searching && (
                <Scatter
                  data={foreground}
                  fill={HIGHLIGHT}
                  fillOpacity={0.95}
                  stroke="var(--surface)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </figure>

      {/* Table view — the exact numbers behind the plot, and the relief for the
          points that sit below 3:1 against the light surface. */}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {columns.map((c) => (
                <th key={c.key} className={`px-3 py-2 ${c.numeric ? 'text-right' : ''}`}>
                  <button
                    type="button"
                    className="font-medium uppercase tracking-wide hover:text-[var(--text-primary)]"
                    onClick={() => setSorting(c.key)}
                  >
                    {c.label}
                    {sort === c.key && (dir === 'asc' ? ' ↑' : ' ↓')}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((p) => (
              <tr
                key={p.player_tag}
                className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-raised)]"
              >
                <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">
                  {p.latest_rank ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/player/${encodeURIComponent(p.player_tag)}`}
                    className="font-medium hover:underline"
                  >
                    {p.player_name ?? p.player_tag}
                  </Link>
                  <span className="ml-2 text-xs text-[var(--text-muted)]">{p.player_tag}</span>
                </td>
                <td className="tabular px-3 py-2 text-right">{p.town_hall_level ?? '—'}</td>
                <td className="px-3 py-2 text-[var(--text-secondary)]">{p.clan_name ?? '—'}</td>
                <td className="tabular px-3 py-2 text-right font-medium">
                  {p.offence_avg?.toFixed(2) ?? '—'}
                </td>
                <td className="tabular px-3 py-2 text-right font-medium">
                  {p.defence_avg?.toFixed(2) ?? '—'}
                </td>
                <td
                  className="tabular px-3 py-2 text-right"
                  style={{
                    color:
                      p.gap === null
                        ? 'var(--text-muted)'
                        : p.gap > 0
                          ? 'var(--good)'
                          : p.gap < 0
                            ? 'var(--critical)'
                            : 'var(--text-secondary)',
                  }}
                >
                  {p.gap === null ? '—' : `${p.gap > 0 ? '+' : ''}${p.gap.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length > limit && (
        <button
          type="button"
          className="rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => setLimit((l) => l + 250)}
        >
          Show more ({(sorted.length - limit).toLocaleString()} remaining)
        </button>
      )}
    </div>
  );
}

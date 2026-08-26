'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlayerHistoryRow } from '@/lib/types';

/**
 * Categorical slots in fixed order — colour follows the player, never their
 * rank, so filtering the set never repaints the survivors. Capped at 5; the
 * compare page enforces the same ceiling.
 */
const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
];

export interface Series {
  tag: string;
  name: string;
  rows: PlayerHistoryRow[];
}

type Metric = 'trophies' | 'rank';

interface Point {
  season: string;
  captured_at: string;
  [key: string]: string | number | null;
}

/** Merge per-player rows onto a shared season axis, ordered by capture time. */
function buildPoints(series: Series[], metric: Metric): Point[] {
  const bySeason = new Map<string, Point>();

  for (const s of series) {
    for (const r of s.rows) {
      let point = bySeason.get(r.season_id);
      if (!point) {
        point = { season: r.season_id, captured_at: r.captured_at };
        bySeason.set(r.season_id, point);
      }
      point[s.tag] = metric === 'rank' ? r.rank : r.trophies;
    }
  }

  return [...bySeason.values()].sort(
    (a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at),
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  metric,
  series,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number }[];
  label?: string;
  metric: Metric;
  series: Series[];
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-[var(--text-primary)]">{label}</p>
      {payload.map((p) => {
        const i = series.findIndex((s) => s.tag === p.dataKey);
        return (
          <p key={p.dataKey} className="flex items-center gap-2 text-[var(--text-secondary)]">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <span>{series[i]?.name ?? p.dataKey}</span>
            <span className="tabular ml-auto font-medium text-[var(--text-primary)]">
              {metric === 'rank' ? `#${p.value}` : p.value?.toLocaleString()}
            </span>
          </p>
        );
      })}
    </div>
  );
}

export default function HistoryChart({
  series,
  metric,
  title,
}: {
  series: Series[];
  metric: Metric;
  title: string;
}) {
  const points = buildPoints(series, metric);

  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">No season data yet.</p>
      </div>
    );
  }

  return (
    <figure className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <figcaption className="mb-1 text-sm font-semibold text-[var(--text-primary)]">
        {title}
      </figcaption>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        {metric === 'rank'
          ? 'Lower is better — the axis is inverted so up means climbing.'
          : 'End-of-season trophy total.'}
      </p>

      {/* A legend is present whenever there is more than one series, so
          identity never rests on colour alone. */}
      {series.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)]">
          {series.map((s, i) => (
            <li key={s.tag} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/* Top margin leaves room for the highest y tick label, which the
              inverted rank scale pushes right against the plot edge. */}
          <LineChart data={points} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="season"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
              minTickGap={24}
            />
            <YAxis
              // Rank is "lower is better", so the scale is inverted and up on
              // the page always means improvement.
              reversed={metric === 'rank'}
              // Ranks are whole numbers — never label a tick "#1.5" — and the
              // scale hugs the data so movement stays visible whether the
              // player sits at #3 or #3000.
              domain={metric === 'rank' ? ['dataMin', 'dataMax'] : ['auto', 'auto']}
              allowDecimals={metric !== 'rank'}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => (metric === 'rank' ? `#${v}` : v.toLocaleString())}
            />
            <Tooltip
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
              content={<ChartTooltip metric={metric} series={series} />}
            />
            {series.map((s, i) => (
              <Line
                key={s.tag}
                type="monotone"
                dataKey={s.tag}
                name={s.name}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={2}
                // The dot carries the series colour; the surface-coloured ring
                // keeps overlapping points readable where lines cross.
                dot={{
                  r: 4,
                  fill: SERIES_COLORS[i % SERIES_COLORS.length],
                  strokeWidth: 2,
                  stroke: 'var(--surface)',
                }}
                activeDot={{
                  r: 6,
                  fill: SERIES_COLORS[i % SERIES_COLORS.length],
                  strokeWidth: 2,
                  stroke: 'var(--surface)',
                }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

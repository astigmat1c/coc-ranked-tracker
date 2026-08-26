import Link from 'next/link';
import { notFound } from 'next/navigation';
import HistoryChart from '@/components/HistoryChart';
import SeasonTable from '@/components/SeasonTable';
import { getPlayer, getPlayerHistory } from '@/lib/queries';

export const revalidate = 300;

export default async function PlayerPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag: raw } = await params;
  const tag = decodeURIComponent(raw).toUpperCase();

  const [player, history] = await Promise.all([getPlayer(tag), getPlayerHistory(tag)]);
  if (!player && history.length === 0) notFound();

  const name = player?.name ?? history.at(-1)?.player_tag ?? tag;
  const best = history.reduce<number | null>(
    (acc, r) => (acc === null || r.rank < acc ? r.rank : acc),
    null,
  );
  const peakTrophies = history.reduce<number | null>(
    (acc, r) => (r.trophies !== null && (acc === null || r.trophies > acc) ? r.trophies : acc),
    null,
  );
  const latest = history.at(-1);

  const series = [{ tag, name, rows: history }];

  return (
    <div className="space-y-5">
      <div>
        <Link href="/rankings" className="text-sm text-[var(--text-muted)] hover:underline">
          ← Rankings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{name}</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {tag}
          {player?.town_hall_level ? ` · TH${player.town_hall_level}` : ''}
          {latest?.clan_name ? ` · ${latest.clan_name}` : ''}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Seasons tracked', value: history.length.toLocaleString() },
          { label: 'Best rank', value: best !== null ? `#${best}` : '—' },
          { label: 'Peak trophies', value: peakTrophies?.toLocaleString() ?? '—' },
          {
            label: 'Latest',
            value: latest ? `#${latest.rank} · ${latest.trophies?.toLocaleString() ?? '—'}` : '—',
          },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <dt className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {s.label}
            </dt>
            <dd className="mt-1 text-xl font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <HistoryChart series={series} metric="trophies" title="Trophies by season" />
        <HistoryChart series={series} metric="rank" title="Rank by season" />
      </div>

      <SeasonTable rows={history} />
    </div>
  );
}

'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import type { LeagueRow, SnapshotRow } from '@/lib/types';

const TOWN_HALLS = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

const field =
  'h-9 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 text-sm ' +
  'text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

const label = 'block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]';

export default function FilterBar({
  leagues,
  seasons,
  countries,
}: {
  leagues: LeagueRow[];
  seasons: SnapshotRow[];
  countries: { code: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [clan, setClan] = useState(params.get('clan') ?? '');

  const push = useCallback(
    (changes: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(changes)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      // Any filter change invalidates the current page offset.
      if (!('page' in changes)) next.delete('page');
      startTransition(() => router.push(`/rankings?${next.toString()}`));
    },
    [params, router],
  );

  const get = (k: string) => params.get(k) ?? '';

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        push({ search: search || undefined, clan: clan || undefined });
      }}
    >
      <div>
        <label className={label} htmlFor="league">
          League
        </label>
        <select
          id="league"
          className={field}
          value={get('league')}
          onChange={(e) => push({ league: e.target.value, season: undefined })}
        >
          {leagues.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={label} htmlFor="season">
          Season
        </label>
        <select
          id="season"
          className={field}
          value={get('season')}
          onChange={(e) => push({ season: e.target.value })}
        >
          {seasons.map((s) => (
            <option key={s.season_id} value={s.season_id}>
              {s.season_id}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={label} htmlFor="search">
          Player
        </label>
        <input
          id="search"
          className={`${field} w-44`}
          placeholder="name or #TAG"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div>
        <label className={label} htmlFor="clan">
          Clan
        </label>
        <input
          id="clan"
          className={`${field} w-44`}
          placeholder="name or #TAG"
          value={clan}
          onChange={(e) => setClan(e.target.value)}
        />
      </div>

      <div>
        <label className={label} htmlFor="country">
          Country
        </label>
        <select
          id="country"
          className={field}
          value={get('country')}
          onChange={(e) => push({ country: e.target.value || undefined })}
        >
          <option value="">All</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={label} htmlFor="th">
          Town Hall
        </label>
        <select
          id="th"
          className={field}
          value={get('th')}
          onChange={(e) => push({ th: e.target.value || undefined })}
        >
          <option value="">All</option>
          {TOWN_HALLS.map((th) => (
            <option key={th} value={th}>
              TH{th}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={label} htmlFor="minTrophies">
          Trophies
        </label>
        <div className="flex items-center gap-1">
          <input
            id="minTrophies"
            className={`${field} tabular w-20`}
            inputMode="numeric"
            placeholder="min"
            defaultValue={get('minTrophies')}
            onBlur={(e) => push({ minTrophies: e.target.value || undefined })}
          />
          <span className="text-[var(--text-muted)]">–</span>
          <input
            className={`${field} tabular w-20`}
            inputMode="numeric"
            placeholder="max"
            aria-label="Maximum trophies"
            defaultValue={get('maxTrophies')}
            onBlur={(e) => push({ maxTrophies: e.target.value || undefined })}
          />
        </div>
      </div>

      <button
        type="submit"
        className="h-9 rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-60"
        disabled={pending}
      >
        {pending ? 'Filtering…' : 'Apply'}
      </button>

      <button
        type="button"
        className="h-9 rounded-md border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)]"
        onClick={() => {
          setSearch('');
          setClan('');
          push({
            search: undefined,
            clan: undefined,
            country: undefined,
            th: undefined,
            minTrophies: undefined,
            maxTrophies: undefined,
          });
        }}
      >
        Reset
      </button>
    </form>
  );
}

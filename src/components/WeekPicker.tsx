'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { SnapshotRow } from '@/lib/types';
import { weekLabel } from '@/lib/weeks';

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

function WeekGroup({
  title,
  hint,
  seasons,
  selected,
  onToggle,
  tone,
}: {
  title: string;
  hint: string;
  seasons: SnapshotRow[];
  selected: string[];
  onToggle: (seasonId: string) => void;
  tone: string;
}) {
  return (
    <fieldset className="min-w-0 flex-1">
      <legend className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </legend>
      <p className="mb-2 text-xs text-[var(--text-muted)]">{hint}</p>
      <div className="flex flex-wrap gap-1.5">
        {seasons.map((s) => {
          const on = selected.includes(s.season_id);
          return (
            <label
              key={s.season_id}
              className="cursor-pointer select-none rounded-md border px-2.5 py-1 text-sm"
              style={{
                borderColor: on ? tone : 'var(--border)',
                color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                boxShadow: on ? `inset 0 0 0 1px ${tone}` : undefined,
              }}
              title={`${s.season_id} · ${s.player_count.toLocaleString()} players`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => onToggle(s.season_id)}
              />
              {weekLabel(s)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export default function WeekPicker({
  leagueId,
  seasons,
  offence,
  defence,
  defaultOffence,
  defaultDefence,
}: {
  leagueId: number;
  seasons: SnapshotRow[];
  offence: string[];
  defence: string[];
  defaultOffence: string[];
  defaultDefence: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [off, setOff] = useState<string[]>(offence);
  const [def, setDef] = useState<string[]>(defence);

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const dirty = !sameSet(off, offence) || !sameSet(def, defence);
  const valid = off.length > 0 && def.length > 0;

  const apply = (nextOff = off, nextDef = def) => {
    const params = new URLSearchParams({
      league: String(leagueId),
      off: nextOff.join(','),
      def: nextDef.join(','),
    });
    startTransition(() => router.push(`/analysis?${params.toString()}`));
  };

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-col gap-4 sm:flex-row">
        <WeekGroup
          title="Offence weeks"
          hint="Attack wins are summed across these, then divided by the week count."
          seasons={seasons}
          selected={off}
          onToggle={(id) => toggle(off, setOff, id)}
          tone="var(--series-1)"
        />
        <WeekGroup
          title="Defence weeks"
          hint="Same, for defence wins. Independent of the offence choice."
          seasons={seasons}
          selected={def}
          onToggle={(id) => toggle(def, setDef, id)}
          tone="var(--series-2)"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          className="h-9 rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
          disabled={!valid || !dirty || pending}
          onClick={() => apply()}
        >
          {pending ? 'Loading…' : dirty ? 'Apply' : 'Applied'}
        </button>
        <button
          type="button"
          className="h-9 rounded-md border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => {
            setOff(defaultOffence);
            setDef(defaultDefence);
            apply(defaultOffence, defaultDefence);
          }}
        >
          Reset to last 3 vs latest
        </button>

        {!valid && (
          <p className="text-sm text-[var(--critical)]">
            Pick at least one week on each side.
          </p>
        )}
        {valid && dirty && (
          <p className="text-sm text-[var(--text-muted)]">
            {off.length} offence {off.length === 1 ? 'week' : 'weeks'} · {def.length} defence{' '}
            {def.length === 1 ? 'week' : 'weeks'} — not applied yet
          </p>
        )}
      </div>
    </div>
  );
}

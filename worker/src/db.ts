import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * Service-role client, created on first use rather than at import time.
 *
 * Import-time construction meant merely importing anything from this module
 * threw when the env was unset — which made every worker module impossible to
 * unit test, and turned a missing variable into a stack trace at load rather
 * than a clear error at the point of use.
 */
export function getDb(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the worker. ' +
        'The service-role key bypasses RLS — keep it out of the Next.js app and out of git.',
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Postgres chokes on very large single inserts; 1000 rows is a comfortable batch. */
export async function upsertChunked<T extends object>(
  table: string,
  rows: T[],
  onConflict: string,
  chunk = 1000,
) {
  for (let i = 0; i < rows.length; ) {
    const size = Math.min(chunk, rows.length - i);
    const written = await upsertSlice(table, rows.slice(i, i + size), onConflict, size);
    i += written;
  }
}

/**
 * Writes one slice, halving it and retrying if the statement times out.
 *
 * Supabase enforces a per-statement timeout, and how many rows fit inside it
 * depends on payload size and index count — not on a number anyone can pick
 * correctly up front. Backing off on timeout means a heavier-than-expected
 * batch slows down instead of failing the whole run.
 *
 * Returns how many rows were actually written so the caller can advance.
 */
async function upsertSlice<T extends object>(
  table: string,
  slice: T[],
  onConflict: string,
  size: number,
): Promise<number> {
  const { error } = await getDb().from(table).upsert(slice as never, { onConflict });
  if (!error) return slice.length;

  const timedOut =
    (error as { code?: string }).code === '57014' || /statement timeout/i.test(error.message);

  if (timedOut && slice.length > 1) {
    const half = Math.max(1, Math.floor(size / 2));
    console.warn(`  upsert into ${table} timed out at ${size} rows; retrying at ${half}`);
    let done = 0;
    while (done < slice.length) {
      const next = slice.slice(done, done + half);
      done += await upsertSlice(table, next, onConflict, next.length);
    }
    return done;
  }

  throw new Error(`upsert into ${table} failed (${slice.length} rows): ${error.message}`);
}

/**
 * Reads every matching row, a page at a time.
 *
 * PostgREST caps responses at its `max-rows` setting — 1000 on Supabase — and
 * enforces it silently: `.limit(20000)` returns 1000 rows and no error. Any
 * read that can exceed 1000 rows must page, or it is quietly wrong. This bit
 * once: a clan table holding 65,973 rows swept only 1,000 of them.
 */
export async function selectPaged<T>(
  page: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  { pageSize = 1000, max = Infinity }: { pageSize?: number; max?: number } = {},
): Promise<T[]> {
  const out: T[] = [];

  for (let from = 0; out.length < max; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    out.push(...rows);
    // A short page means the end of the result set.
    if (rows.length < pageSize) break;
  }

  return max === Infinity ? out : out.slice(0, max);
}

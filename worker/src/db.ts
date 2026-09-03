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
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await getDb().from(table).upsert(slice as never, { onConflict });
    if (error) {
      throw new Error(`upsert into ${table} failed at row ${i}: ${error.message}`);
    }
  }
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

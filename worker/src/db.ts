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

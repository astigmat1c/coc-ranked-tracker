import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the worker. ' +
      'The service-role key bypasses RLS — keep it out of the Next.js app and out of git.',
  );
}

export const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Postgres chokes on very large single inserts; 1000 rows is a comfortable batch. */
export async function upsertChunked<T extends object>(
  table: string,
  rows: T[],
  onConflict: string,
  chunk = 1000,
) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await db.from(table).upsert(slice as never, { onConflict });
    if (error) {
      throw new Error(`upsert into ${table} failed at row ${i}: ${error.message}`);
    }
  }
}

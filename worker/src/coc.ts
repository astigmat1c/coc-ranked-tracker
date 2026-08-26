/**
 * Thin client for the official Supercell Clash of Clans API.
 *
 * The API binds each key to a fixed IP address. Set COC_API_BASE to
 * https://cocproxy.royaleapi.dev/v1 and whitelist 45.79.218.79 when creating
 * the key, or point it at https://api.clashofclans.com/v1 from a host whose
 * IP you control.
 */

const BASE = process.env.COC_API_BASE ?? 'https://cocproxy.royaleapi.dev/v1';
const TOKEN = process.env.COC_API_TOKEN ?? '';

/** Undocumented, but ~30-40 req/s is the community-observed ceiling. */
const CONCURRENCY = Number(process.env.COC_CONCURRENCY ?? 10);
const MAX_RETRIES = Number(process.env.COC_MAX_RETRIES ?? 5);

export class CocApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`CoC API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'CocApiError';
  }
}

/** Minimal semaphore — keeps us under the rate limit without a dependency. */
function createGate(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return async function gate<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const gate = createGate(CONCURRENCY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cocFetch<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  if (!TOKEN) {
    throw new Error(
      'COC_API_TOKEN is not set. Create a key at developer.clashofclans.com ' +
        '(whitelist 45.79.218.79 if you are using the RoyaleAPI proxy).',
    );
  }

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  return gate(async () => {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        // Network blip — back off and try again.
        lastErr = err;
        await sleep(2 ** attempt * 500);
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');

      // 429 (throttled) and 5xx (upstream maintenance) are worth retrying.
      // 403 usually means the key's IP doesn't match — retrying won't help.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new CocApiError(res.status, path, body);
        await sleep(2 ** attempt * 750);
        continue;
      }

      throw new CocApiError(res.status, path, body);
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`CoC API request to ${path} failed after ${MAX_RETRIES} retries`);
  });
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface Paged<T> {
  items: T[];
  paging?: { cursors?: { after?: string; before?: string } };
}

/**
 * Walks a cursor-paginated endpoint to exhaustion (or to `max` items).
 * The API caps `limit` well below the full list, so every ranking pull pages.
 */
export async function cocFetchAll<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  { pageSize = 200, max = Infinity }: { pageSize?: number; max?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;

  for (;;) {
    const page = await cocFetch<Paged<T>>(path, { ...params, limit: pageSize, after });
    out.push(...page.items);

    after = page.paging?.cursors?.after;
    if (!after || page.items.length === 0 || out.length >= max) break;
  }

  return max === Infinity ? out : out.slice(0, max);
}

/** Runs `fn` over `items` with the same concurrency ceiling as the fetcher. */
export async function mapLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );

  return results;
}

/** Player and clan tags contain '#', which must be percent-encoded in paths. */
export const encodeTag = (tag: string) =>
  encodeURIComponent(tag.startsWith('#') ? tag : `#${tag}`);

/** Normalised form we store: uppercase, leading '#', O->0 typo fix omitted deliberately. */
export const normaliseTag = (tag: string) =>
  (tag.startsWith('#') ? tag : `#${tag}`).toUpperCase().trim();

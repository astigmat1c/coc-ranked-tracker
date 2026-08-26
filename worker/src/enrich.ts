/**
 * Enrichment pass — fills in the fields the ranking endpoints don't return.
 *
 * Town Hall level comes from /players/{tag}; country comes from the player's
 * clan via /clans/{tag}. Both are per-entity calls, so this is the expensive
 * job: roughly one call per ranked player per run. It runs after ingest.
 *
 *   npm run enrich                 # refresh anything stale
 *   npm run enrich -- --limit 2000
 *   npm run enrich -- --max-age 30 # days before a record is considered stale
 */
import 'dotenv/config';
import { cocFetch, encodeTag, mapLimit, normaliseTag, CocApiError } from './coc.js';
import { db, upsertChunked } from './db.js';

interface PlayerDetail {
  tag: string;
  name: string;
  expLevel?: number;
  townHallLevel?: number;
  league?: { id: number };
  clan?: { tag: string; name?: string };
}

interface ClanDetail {
  tag: string;
  name: string;
  clanLevel?: number;
  badgeUrls?: Record<string, string>;
  location?: { id: number; name: string; isCountry?: boolean; countryCode?: string };
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

async function enrichPlayers(limit: number, staleBefore: string) {
  // Never-enriched rows first (enriched_at nulls first in the index), then the
  // stalest. A capped batch keeps a single run bounded and resumable.
  const { data, error } = await db
    .from('players')
    .select('tag')
    .or(`enriched_at.is.null,enriched_at.lt.${staleBefore}`)
    .order('enriched_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw new Error(`player selection failed: ${error.message}`);
  const tags = (data ?? []).map((r) => r.tag as string);
  if (!tags.length) {
    console.log('players: nothing stale');
    return;
  }

  console.log(`players: enriching ${tags.length}`);
  const now = new Date().toISOString();
  const rows: object[] = [];
  let missing = 0;

  await mapLimit(tags, async (tag) => {
    try {
      const p = await cocFetch<PlayerDetail>(`/players/${encodeTag(tag)}`);
      rows.push({
        tag: normaliseTag(p.tag),
        name: p.name,
        exp_level: p.expLevel ?? null,
        town_hall_level: p.townHallLevel ?? null,
        clan_tag: p.clan?.tag ? normaliseTag(p.clan.tag) : null,
        league_id: p.league?.id ?? null,
        raw: p,
        enriched_at: now,
      });
    } catch (err) {
      // 404 = account deleted or tag changed. Stamp it so we stop retrying it
      // every run, but leave the historical ranking rows intact.
      if (err instanceof CocApiError && err.status === 404) {
        missing++;
        rows.push({ tag: normaliseTag(tag), enriched_at: now });
        return;
      }
      throw err;
    }
  });

  await upsertChunked('players', rows, 'tag');
  console.log(`players: ${rows.length - missing} updated, ${missing} not found`);
}

async function enrichClans(limit: number) {
  // Clans only need one field we can't get elsewhere — location — so we only
  // fetch the ones still missing it.
  const { data, error } = await db
    .from('clans')
    .select('tag')
    .is('location_id', null)
    .limit(limit);

  if (error) throw new Error(`clan selection failed: ${error.message}`);
  const tags = (data ?? []).map((r) => r.tag as string);
  if (!tags.length) {
    console.log('clans: nothing missing a location');
    return;
  }

  console.log(`clans: enriching ${tags.length}`);
  const locations = new Map<number, object>();
  const rows: object[] = [];

  await mapLimit(tags, async (tag) => {
    try {
      const c = await cocFetch<ClanDetail>(`/clans/${encodeTag(tag)}`);
      if (c.location) {
        locations.set(c.location.id, {
          id: c.location.id,
          name: c.location.name,
          is_country: Boolean(c.location.isCountry),
          country_code: c.location.countryCode ?? null,
        });
      }
      rows.push({
        tag: normaliseTag(c.tag),
        name: c.name,
        level: c.clanLevel ?? null,
        badge_urls: c.badgeUrls ?? null,
        location_id: c.location?.id ?? null,
        raw: c,
        last_seen_at: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof CocApiError && err.status === 404) return;
      throw err;
    }
  });

  // Locations before clans — clans.location_id is a foreign key.
  if (locations.size) await upsertChunked('locations', [...locations.values()], 'id');
  await upsertChunked('clans', rows, 'tag');
  console.log(`clans: ${rows.length} updated, ${locations.size} locations seen`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(args.limit ?? process.env.ENRICH_LIMIT ?? 12000);
  const maxAgeDays = Number(args['max-age'] ?? 7);
  const staleBefore = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();

  await enrichPlayers(limit, staleBefore);
  await enrichClans(limit);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

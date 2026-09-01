import type { SnapshotRow } from './types';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Human label for a captured week, e.g. "24 Aug".
 *
 * Formatted by hand rather than with toLocaleDateString: this runs on both the
 * server and the client, and Intl output depends on the host's locale and time
 * zone, so the two would disagree and React would flag a hydration mismatch.
 * Read in UTC for the same reason — the season boundary is a fixed instant, not
 * a local calendar day.
 *
 * Season ids come from the API and their format isn't guaranteed, so anything
 * that doesn't parse as a date falls back to the raw id rather than rendering
 * "Invalid Date".
 */
export function weekLabel(season: SnapshotRow): string {
  const source = /^\d{4}-\d{2}-\d{2}/.test(season.season_id)
    ? season.season_id.slice(0, 10)
    : season.captured_at;

  const d = new Date(source);
  if (Number.isNaN(d.getTime())) return season.season_id;

  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

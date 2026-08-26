import Link from 'next/link';

export default function Pagination({
  page,
  pageSize,
  total,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  params: Record<string, string | undefined>;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage <= 1) return null;

  const href = (p: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) next.set(k, v);
    next.set('page', String(p));
    return `/rankings?${next.toString()}`;
  };

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const btn =
    'rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <p className="tabular text-[var(--text-muted)]">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={btn}>
            Previous
          </Link>
        ) : (
          <span className={`${btn} opacity-40`}>Previous</span>
        )}
        <span className="tabular text-[var(--text-muted)]">
          {page} / {lastPage}
        </span>
        {page < lastPage ? (
          <Link href={href(page + 1)} className={btn}>
            Next
          </Link>
        ) : (
          <span className={`${btn} opacity-40`}>Next</span>
        )}
      </div>
    </div>
  );
}

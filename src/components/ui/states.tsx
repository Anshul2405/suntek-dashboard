import React from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils/cn';

/**
 * Shared async-state primitives so every list/panel renders loading, empty,
 * and error states consistently instead of blank tables or alert() dialogs.
 *
 * Pairs with the useTable hook (data layer) and the page-level ErrorBoundary
 * (render-time crashes). These cover *data* states; ErrorBoundary covers *throws*.
 */

/** A single shimmer line. Width is a Tailwind class e.g. 'w-1/2'. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('ledger-skel', className)} style={style} />;
}

/** A block of skeleton rows to stand in for a loading table/list. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} style={{ animationDelay: `${i * 70}ms` }} />
      ))}
    </div>
  );
}

/** Empty state — data loaded successfully but there is nothing to show. */
export function EmptyState({
  title = 'Nothing here yet',
  message,
  icon,
  action,
  className,
}: {
  title?: string;
  message?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <span className="text-gray-300">{icon ?? <Inbox size={28} />}</span>
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {message && <p className="max-w-sm text-xs text-gray-500">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Error state — a fetch/query failed. Optionally offers a retry. */
export function ErrorState({
  title = 'Could not load this data',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <span className="text-amber-500">
        <AlertTriangle size={28} />
      </span>
      <p className="text-sm font-medium text-gray-800">{title}</p>
      {message && <p className="max-w-sm text-xs text-gray-500">{message}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          <RefreshCw size={13} />
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Convenience switch: render the right state for a typical query.
 * Returns `null` when data is ready so the caller renders its own content.
 */
export function AsyncState({
  isLoading,
  isError,
  isEmpty,
  onRetry,
  loadingRows,
  emptyTitle,
  emptyMessage,
  errorMessage,
}: {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  onRetry?: () => void;
  loadingRows?: number;
  emptyTitle?: string;
  emptyMessage?: string;
  errorMessage?: string;
}): React.ReactElement | null {
  if (isLoading) return <SkeletonRows rows={loadingRows} />;
  if (isError) return <ErrorState message={errorMessage} onRetry={onRetry} />;
  if (isEmpty) return <EmptyState title={emptyTitle} message={emptyMessage} />;
  return null;
}

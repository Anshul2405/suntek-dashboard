import React, { useMemo } from 'react';

/**
 * Consistent table search box + matching filter helper, so every list filters the
 * same way instead of each page rolling its own input + matcher.
 *
 *   const [q, setQ] = useState('');
 *   const rows = useTextFilter(allRows, q, r => [r.item, r.plant, r.ref]);
 *   <TableSearch value={q} onChange={setQ} placeholder="Search requirements…" />
 */

export function TableSearch({
  value,
  onChange,
  placeholder = 'Search…',
  width = '100%',
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: string | number;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ position: 'relative', width, marginBottom: 12, ...style }}>
      <svg
        width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"
        style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
      >
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
      </svg>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        // Phones: 44px tall, 16px text so iOS does not zoom on focus.
        className="max-sm:min-h-[44px] max-sm:!text-[16px]"
        style={{
          width: '100%', border: '1px solid #E2E8F0', borderRadius: 8, padding: '7px 30px 7px 32px',
          fontSize: 13, fontFamily: 'inherit', outline: 'none',
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', color: '#94A3B8', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** Case-insensitive multi-field substring filter. `fields` returns the searchable
 *  strings for a row; a row matches when any field contains the (trimmed) query. */
export function useTextFilter<T>(rows: T[], query: string, fields: (row: T) => (string | null | undefined)[]): T[] {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => fields(r).some(f => (f || '').toLowerCase().includes(q)));
  }, [rows, query]); // eslint-disable-line react-hooks/exhaustive-deps
}

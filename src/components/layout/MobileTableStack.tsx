import { useEffect } from 'react';

/**
 * Phone screens cannot read a 10-column desktop table. Stamp each cell with
 * its column name so CSS can stack the row into a labeled card. Tables marked
 * .desktop-only-table already have a hand-built card list and stay hidden.
 */
function labelTables() {
  if (typeof window === 'undefined') return;
  const phone = window.matchMedia('(max-width: 767px)').matches;
  document.querySelectorAll<HTMLTableElement>('table.dt2').forEach(table => {
    if (table.closest('.desktop-only-table')) return;
    const heads = [...table.querySelectorAll('thead th')].map(th =>
      (th.textContent || '').replace(/[▲▼▴▾↑↓]/g, '').replace(/\s+/g, ' ').trim(),
    );
    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = [...tr.children].filter((el): el is HTMLTableCellElement => el.tagName === 'TD');
      const spanned = cells.some(td => td.colSpan > 1);
      cells.forEach((td, i) => {
        if (!phone || spanned) td.removeAttribute('data-label');
        else td.setAttribute('data-label', heads[i] || '');
      });
    });
  });
}

export function MobileTableStack() {
  useEffect(() => {
    labelTables();
    const obs = new MutationObserver(() => labelTables());
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', labelTables);
    const mq = window.matchMedia('(max-width: 767px)');
    mq.addEventListener('change', labelTables);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', labelTables);
      mq.removeEventListener('change', labelTables);
    };
  }, []);
  return null;
}

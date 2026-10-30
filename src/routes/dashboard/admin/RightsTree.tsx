import { useTranslation } from 'react-i18next';
import type { OpsSettings } from '../../../lib/opsControls';
import { countOn, tickState, type RightsSubject, type RoleLite, type TreeNode } from '../../../lib/access/rightsTree';

/**
 * Busy's Menu Rights tree: + / − branches, a tick per page, per tab and per
 * Add / Modify / Delete. A page that is off dims what is under it (no page =
 * no tab, no button). A person's own tick (beats the role) carries a "P".
 */
export function RightsTree({
  nodes, settings, roles, subject, open, setOpen, onTick, locked, readOnly,
}: {
  nodes: TreeNode[];
  settings: OpsSettings;
  roles: RoleLite[];
  subject: RightsSubject;
  open: Record<string, boolean>;
  setOpen: (fn: (o: Record<string, boolean>) => Record<string, boolean>) => void;
  onTick: (node: TreeNode, on: boolean) => void;
  /** Owner / Admin: everything on, nothing to change. */
  locked?: boolean;
  /** Can see but not change (no Admin rights). */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const label = (n: TreeNode) => t(n.labelKey, n.label);

  const render = (n: TreeNode, path: string[], parentOn: boolean) => {
    const hasKids = n.children.length > 0;
    const isOpen = !!open[n.id];
    const tickable = n.kind === 'section' || n.kind === 'tab' || n.kind === 'verb';
    const st = tickable ? tickState(settings, roles, subject, n) : null;
    const on = locked ? true : !!st?.on;
    const name = label(n);
    const fullPath = [...path, name];
    const count = hasKids && !isOpen ? countOn(settings, roles, subject, n) : null;
    const pm = hasKids ? (
      <button
        type="button"
        className="bz-pm"
        aria-expanded={isOpen}
        aria-label={`${isOpen ? t('rights.collapse', 'Collapse') : t('rights.expand', 'Expand')} ${fullPath.join(' › ')}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => ({ ...o, [n.id]: !isOpen })); }}
      >{isOpen ? '−' : '+'}</button>
    ) : <span className="bz-pm-sp" />;
    const text = (
      <>
        <span className={n.kind === 'group' ? 'font-bold' : n.kind === 'section' ? 'font-semibold' : n.kind === 'module' ? 'italic text-slate-600' : ''}>{name}</span>
        {n.hint && <span className="text-slate-500 text-[11.5px]">— {t(n.hintKey || '', n.hint)}</span>}
        {st?.own && <span className="bz-tag" style={{ color: on ? '#15803D' : '#B91C1C' }} title={t('um.ownTitle', 'This person’s own setting — it beats the role. Click again to follow the role.')}>P</span>}
        {count && <span className="text-[11px] text-slate-400">{count.on}/{count.total}</span>}
      </>
    );
    return (
      <li key={n.id} role="treeitem" aria-expanded={hasKids ? isOpen : undefined} style={{ opacity: parentOn || locked ? 1 : 0.55 }}>
        {tickable ? (
          // The +/− sits OUTSIDE the label: a label hands its clicks to its first control,
          // so tapping "Dispatch" must tick, never open the branch.
          <div className="bz-tree-row">
            {pm}
            <label className="flex flex-1 items-center gap-[5px] self-stretch min-w-0" style={{ cursor: locked || readOnly ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              aria-label={fullPath.join(' › ')}
              checked={on}
              disabled={locked || readOnly}
              onChange={(e) => onTick(n, e.target.checked)}
            />
            {text}
            </label>
          </div>
        ) : (
          <div className="bz-tree-row" onClick={() => hasKids && setOpen((o) => ({ ...o, [n.id]: !isOpen }))} style={{ cursor: hasKids ? 'pointer' : 'default' }}>
            {pm}
            {text}
          </div>
        )}
        {hasKids && isOpen && (
          <ul role="group">
            {n.children.map((c) => render(c, n.kind === 'group' ? [] : fullPath, n.kind === 'group' || n.kind === 'module' ? parentOn : parentOn && on))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className="bz-tree" role="tree" aria-label={t('um.menuRights', 'Menu Rights')}>
      {nodes.map((n) => render(n, [], true))}
    </ul>
  );
}

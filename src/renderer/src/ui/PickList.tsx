// PickList: search + check + order number (SPEC 공통 컴포넌트, UI 그라운드룰 "여러 개 고르기"). Checked
// items rise to the top in the order they were checked and carry an order circle; the rest follow,
// filtered by the search. The caller owns `picked` / `query` and puts its add button in `children`.
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface PickItem {
  key: string;
  /** What people read (name, path small) — the row's label. */
  label: ReactNode;
  /** Text the search matches (lowercased compare; join several fields with a newline). */
  search: string;
  /** Extra marker after the label (e.g. "들어 있음"). */
  note?: ReactNode;
}

export function PickList({
  items,
  picked,
  onPickedChange,
  query,
  onQueryChange,
  placeholder,
  testId,
  children,
}: {
  items: PickItem[];
  picked: string[];
  onPickedChange: (keys: string[]) => void;
  query: string;
  onQueryChange: (q: string) => void;
  placeholder: string;
  /** `testId` on the box; `${testId}-search` on the input; `${testId}-item` (data-path, data-order) on each row label. */
  testId: string;
  children?: ReactNode;
}) {
  const q = query.trim().toLowerCase();
  const rows = [
    ...picked.map((k) => items.find((x) => x.key === k)).filter((x): x is PickItem => !!x),
    ...items.filter((x) => !picked.includes(x.key) && (!q || x.search.toLowerCase().includes(q))),
  ];
  return (
    <div className="pick" data-testid={testId}>
      <label className="pick-search">
        <Search size={14} strokeWidth={2} aria-hidden="true" />
        <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder={placeholder} data-testid={`${testId}-search`} />
      </label>
      <ul className="pick-list">
        {rows.map((x) => {
          const n = picked.indexOf(x.key);
          return (
            <li key={x.key} className={cx(n >= 0 && 'is-picked')}>
              <label data-testid={`${testId}-item`} data-path={x.key} data-order={n >= 0 ? n + 1 : undefined}>
                <input type="checkbox" checked={n >= 0} onChange={(e) => onPickedChange(e.target.checked ? [...picked, x.key] : picked.filter((y) => y !== x.key))} />
                <span className="pick-label">{x.label}</span>
                {x.note}
                {n >= 0 && <span className="order">{n + 1}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {children}
    </div>
  );
}

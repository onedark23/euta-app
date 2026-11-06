// Tabs: pill group (--surface-2 track; the selected tab is --surface + shadow). Same look as the web's
// Tabs; here the items are buttons (no router). `asTablist` adds tablist/tab roles.
import { cx } from './cx';

export interface TabItem {
  key: string;
  label: string;
  testId?: string;
  title?: string;
}

export function Tabs({ items, active, onSelect, asTablist, label, testId }: { items: TabItem[]; active: string; onSelect: (key: string) => void; asTablist?: boolean; label?: string; testId?: string }) {
  return (
    <div className="tabs" role={asTablist ? 'tablist' : undefined} aria-label={label} data-testid={testId}>
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          className={cx('tab', t.key === active && 'is-active')}
          onClick={() => onSelect(t.key)}
          title={t.title}
          data-testid={t.testId}
          {...(asTablist ? { role: 'tab', 'aria-selected': t.key === active } : { 'aria-pressed': t.key === active })}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Switch: on/off settings. Same props as the web's Switch; here the native checkbox itself is drawn as
// the track (appearance: none), so it stays the click target that tests and keyboards use.
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & { label: ReactNode; className?: string };

export function Switch({ label, className, ...rest }: CheckProps) {
  return (
    <label className={cx('switch', className)}>
      <input type="checkbox" role="switch" {...rest} />
      <span>{label}</span>
    </label>
  );
}

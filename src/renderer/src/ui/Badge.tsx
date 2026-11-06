// Badge: dot + text, pill. Tones follow SPEC "상태 매핑" (ok · bad · run · warn · idle = grey · manual =
// "수동 확인 필요", a reached manual step); `neutral`
// is a grey tag without the dot (e.g. "기본", "현재").
import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export type BadgeTone = 'ok' | 'bad' | 'warn' | 'run' | 'idle' | 'neutral' | 'manual';

const RUN_TONE: Record<string, BadgeTone> = {
  passed: 'ok',
  failed: 'bad',
  error: 'bad',
  timeout: 'bad',
  aborted: 'bad',
  queued: 'run',
  leased: 'run',
  running: 'run',
  cancelled: 'idle',
  skipped: 'idle',
};

/**
 * Run / step state → the word people read (SPEC 글쓰기 "앱·웹 같은 말", same as the web's RUN_STATUS_KO).
 * `pending` · `unknown` · `done` are app-only states (test set item not started yet, run state not known,
 * an AI tool call or hook that finished). The raw value stays in `data-status` for tests and code.
 */
export const STATUS_LABEL: Record<string, string> = {
  queued: '대기',
  leased: '시작 중',
  running: '실행 중',
  passed: '통과',
  failed: '실패',
  error: '오류',
  timeout: '시간 초과',
  aborted: '중단',
  cancelled: '취소',
  skipped: '건너뜀',
  flaky: '불안정',
  pending: '대기',
  unknown: '알 수 없음',
  done: '완료',
};

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

/** Run status → badge tone (flaky passes are `warn`). */
export const runTone = (status: string, flaky?: boolean): BadgeTone => (flaky && status === 'passed' ? 'warn' : (RUN_TONE[status] ?? 'idle'));

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx('badge', `badge-${tone}`, className)} {...rest} />;
}

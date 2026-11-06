// Project activity timeline: activity/<YYYY-MM>.jsonl, one JSON object per line,
// append-only (earlier lines survive a crash). Never throws into callers. Callers pass
// summaries without secret values; `redact` is a last line of defence on top.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityActor, ActivityEvent, ActivityQuery } from '../../shared/types.js';

export const ACTIVITY_KINDS = [
  'project.created',
  'project.updated',
  'env.created',
  'env.updated',
  'env.deleted',
  'secret.set',
  'secret.removed',
  'script.created',
  'script.imported',
  'script.renamed',
  'script.deleted',
  'script.changed',
  'script.restored',
  'run.started',
  'run.finished',
  'suite.started',
  'suite.finished',
  'chat.started',
  'chat.turn',
  'recording.started',
  'recording.finished',
  'recording.converted',
  'tcdoc.imported',
  'tcdoc.converted',
  'tcdoc.exported',
  'tcdoc.deleted',
  'settings.changed',
] as const;

const ACTORS = new Set<ActivityActor>(['user', 'ai', 'mcp', 'suite']);
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
const MAX_SUMMARY = 500;

export function monthOf(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
}

export interface ActivityLogOptions {
  now?: () => Date;
  /** Masks secret values in summaries (defence in depth). */
  redact?: (s: string) => string;
  onAppend?: (e: ActivityEvent) => void;
}

export class ActivityLog {
  readonly dir: string;

  constructor(
    projectDir: string,
    private readonly o: ActivityLogOptions = {},
  ) {
    this.dir = join(projectDir, 'activity');
  }

  /** Append one event. Returns it, or undefined if it could not be written. */
  append(kind: string, actor: ActivityActor, summary: string, ref?: ActivityEvent['ref']): ActivityEvent | undefined {
    try {
      const at = (this.o.now ?? (() => new Date()))();
      let s = String(summary ?? '').replace(/[\r\n]+/g, ' ');
      if (this.o.redact) s = this.o.redact(s);
      const e: ActivityEvent = { at: at.toISOString(), kind, actor: ACTORS.has(actor) ? actor : 'user', summary: s.slice(0, MAX_SUMMARY), ...(ref && Object.keys(ref).length ? { ref } : {}) };
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${monthOf(at)}.jsonl`), `${JSON.stringify(e)}\n`, { mode: 0o600 });
      try {
        this.o.onAppend?.(e);
      } catch {
        /* listener errors never reach the caller */
      }
      return e;
    } catch {
      return undefined;
    }
  }

  /** Newest first, across month files. Malformed lines are skipped. */
  list(q: ActivityQuery = {}): ActivityEvent[] {
    try {
      if (!existsSync(this.dir)) return [];
      const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
      const kinds = q.kinds?.length ? new Set(q.kinds) : undefined;
      const actors = q.actors?.length ? new Set(q.actors) : undefined;
      const files = readdirSync(this.dir)
        .filter((f) => MONTH_FILE.test(f))
        .sort()
        .reverse();
      const out: ActivityEvent[] = [];
      for (const f of files) {
        const lines = readFileSync(join(this.dir, f), 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!.trim();
          if (!line) continue;
          let e: ActivityEvent;
          try {
            e = JSON.parse(line) as ActivityEvent;
          } catch {
            continue;
          }
          if (typeof e.at !== 'string' || typeof e.kind !== 'string') continue;
          if (kinds && !kinds.has(e.kind)) continue;
          if (actors && !actors.has(e.actor)) continue;
          out.push(e);
          if (out.length >= limit) return out;
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

// get_recording — the project's demonstration recordings for the in-app AI chat
// (SPEC 스크립트-작성-시연녹화 "AI 정리"): events, notes, checkpoints, the mechanical
// draft YAML and the secret NAMES it needs; screenshots only on request. Defined through
// the engine tool guard, so every text result is masked with the environment's secrets.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { recordingToScript, relativeUrl, type Recording, type RecordingEvent } from '@euta/core';
import { text, ToolError, type EutaTool, type EutaTools, type ToolContent } from '@euta/mcp-server/tools';
import type { RecordingSummary } from '../../shared/types.js';

export interface RecordingAccess {
  get(id: string): Recording | undefined;
  list(): RecordingSummary[];
  /** Absolute path of a file inside the recording folder (throws on traversal). */
  file(id: string, rel: string): string;
  /** Secret names of the chat's environment (names only). */
  secretNames(): string[];
}

const MAX_SHOTS = 6;

/** What the AI sees of one event: no element keys, no re-find selectors. */
function compact(e: RecordingEvent, baseUrl: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { seq: e.seq, atMs: e.at, kind: e.kind, url: relativeUrl(e.url, baseUrl) };
  if (e.target) out.target = { chosen: e.target.chosen, candidates: e.target.candidates.map((c) => ({ ...c.target, matches: c.count })) };
  for (const k of ['value', 'values', 'key', 'files', 'download', 'nav', 'scroll', 'checkpoint', 'sensitive', 'secretHint', 'note', 'reason'] as const) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  if (e.field) out.field = { tag: e.field.tag, ...(e.field.type ? { type: e.field.type } : {}), ...(e.field.label ? { label: e.field.label } : {}) };
  if (e.kind === 'click' && e.interactive === false) out.emptyArea = true;
  if (e.shot) out.hasScreenshot = true;
  return out;
}

export function createRecordingTools(t: EutaTools, acc: RecordingAccess): EutaTool[] {
  return [
    t.define({
      name: 'get_recording',
      title: 'Get a demonstration recording',
      description:
        'A recording the user made by demonstrating the site (시연 녹화): events (navigations, clicks, inputs, checkpoints, downloads) with target candidates, the user\'s notes, a mechanical draft YAML, and the secret names the draft needs (names only — sensitive inputs were never recorded). Pass screenshots: [seq, ...] (max 6) for masked step screenshots when the events are not enough.',
      inputShape: {
        recordingId: z.string().describe('Recording id (from the user message "recordingId: ...").'),
        screenshots: z.array(z.number().int().positive()).max(MAX_SHOTS).optional().describe('Event seqs whose screenshots to return.'),
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const r = acc.get(a.recordingId);
        if (!r) {
          const ids = acc
            .list()
            .slice(0, 20)
            .map((s) => `${s.id} (${s.name})`);
          throw new ToolError(`recording not found: ${a.recordingId}. Recordings of this project: ${ids.join(', ') || 'none'}`);
        }
        const draft = recordingToScript(r, { secretNames: acc.secretNames() });
        const content: ToolContent[] = [
          text({
            id: r.id,
            name: r.name,
            startUrl: relativeUrl(r.startUrl, r.baseUrl),
            startedAt: r.startedAt,
            ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
            browser: r.browser,
            events: r.events.map((e) => compact(e, r.baseUrl)),
            notes: r.notes,
            checkpoints: r.events.filter((e) => e.kind === 'checkpoint').length,
            secretsNeeded: draft.secrets,
            missingSecrets: draft.missingSecrets,
            notRecorded: draft.notRecorded,
            screenshotsAvailable: r.events.filter((e) => e.shot).map((e) => e.seq),
            draft: 'the next text block is the mechanical draft YAML',
          }),
          text(draft.yaml),
        ];
        for (const seq of a.screenshots ?? []) {
          const e = r.events.find((x) => x.seq === seq);
          if (!e?.shot) {
            content.push(text({ seq, screenshot: 'none for this event' }));
            continue;
          }
          content.push(text({ seq, screenshot: e.shot }));
          content.push({ type: 'image', data: readFileSync(acc.file(r.id, e.shot)).toString('base64'), mimeType: 'image/png' });
        }
        return content;
      },
    }),
  ];
}

// Chat history persisted as one JSON file per chat under <project>/chats (ADR-015, ADR-016).
// Screenshots are kept in memory only (not written to disk).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatSummary, ChatView } from '../../shared/types.js';

const MAX_CHATS = 100;
const ID = /^[0-9a-f-]{36}$/;

export function summaryOf(c: ChatView): ChatSummary {
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, busy: c.busy };
}

/** Make a loaded chat consistent (the app may have quit mid-turn). */
export function reviveChat(c: ChatView): ChatView {
  c.busy = false;
  c.thinking = false;
  for (const i of c.items) {
    if (i.kind === 'assistant') i.streaming = false;
    if (i.kind === 'tool' && i.status === 'running') {
      i.status = 'error';
      i.result = 'interrupted (app closed during the call)';
    }
  }
  return c;
}

export class ChatStore {
  private readonly dir: string;
  private readonly chats = new Map<string, ChatView>();

  /** `dir` = the project's chats/ folder. */
  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as ChatView;
        if (typeof c.id === 'string' && ID.test(c.id) && Array.isArray(c.items)) this.chats.set(c.id, reviveChat(c));
      } catch {
        /* unreadable chat file: skip */
      }
    }
  }

  list(): ChatSummary[] {
    return [...this.chats.values()].map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ChatView | undefined {
    return this.chats.get(id);
  }

  create(cwd: string, model?: string, extra: { projectId?: string; envId?: string } = {}): ChatView {
    const now = Date.now();
    const c: ChatView = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      busy: false,
      thinking: false,
      cwd,
      ...(model ? { model } : {}),
      ...(extra.projectId ? { projectId: extra.projectId } : {}),
      ...(extra.envId ? { envId: extra.envId } : {}),
      items: [],
    };
    this.chats.set(c.id, c);
    this.prune();
    return c;
  }

  save(c: ChatView): void {
    mkdirSync(this.dir, { recursive: true });
    const stripped: ChatView = { ...c, busy: false, thinking: false, items: c.items.map((i) => (i.kind === 'tool' && i.image ? { ...i, image: undefined } : i)) };
    const file = join(this.dir, `${c.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(stripped));
    renameSync(`${file}.tmp`, file);
  }

  delete(id: string): void {
    this.chats.delete(id);
    if (ID.test(id)) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  private prune(): void {
    const old = this.list().slice(MAX_CHATS);
    for (const s of old) if (!s.busy) this.delete(s.id);
  }
}

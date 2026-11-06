// Sync engine (ADR-025) against an in-memory fake server with the real save rules: base version
// check (409 + current), unchanged content, YAML/validation rejections (422), change feed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptHash } from '@euta/core';
import { CloudError, CloudNetworkError } from '../../src/main/cloud/client.js';
import { ProjectSync, type SyncApi, type SyncHost, type SyncNotice } from '../../src/main/cloud/sync.js';
import type { CloudSnapshot, ScriptDto, ScriptVersionDto } from '../../src/main/cloud/types.js';
import { compactId, expandId, WorkingCopy } from '../../src/main/cloud/workcopy.js';

const PID = '11111111-2222-3333-4444-555555555555';
const ME = 'user-me';
const OTHER = 'user-other';
const script = (name: string, extra = '') => `version: 1\nname: ${name}\nsteps:\n  - goto: /${extra}\n`;

class FakeServer implements SyncApi {
  scriptsMap = new Map<string, { id: string; versions: { version: number; source: string; author: string; at: string }[] }>();
  puts: { path: string; baseVersion: number | null; origin: string }[] = [];
  down = false;
  private n = 0;
  user = ME;

  private guard() {
    if (this.down) throw new CloudNetworkError('down');
  }
  dto(path: string): ScriptDto & { source: string } {
    const s = this.scriptsMap.get(path)!;
    const v = s.versions.at(-1)!;
    return { id: s.id, path, version: v.version, contentHash: scriptHash(v.source), validationOk: true, updatedAt: v.at, updatedBy: { id: v.author, name: v.author }, source: v.source };
  }
  /** Someone else saves directly on the server. */
  saveAs(author: string, path: string, source: string): number {
    let s = this.scriptsMap.get(path);
    if (!s) this.scriptsMap.set(path, (s = { id: `s${++this.n}`, versions: [] }));
    const version = (s.versions.at(-1)?.version ?? 0) + 1;
    s.versions.push({ version, source, author, at: new Date().toISOString() });
    return version;
  }
  async project() {
    this.guard();
    return { id: PID, name: 'P', description: '', browser: { engine: 'chromium' as const }, testRules: '', defaultEnvironmentId: null, myRole: 'editor' as const, can: ['script.edit'], updatedAt: '' };
  }
  async environments() {
    this.guard();
    return [];
  }
  async suites() {
    this.guard();
    return [];
  }
  async scripts() {
    this.guard();
    return [...this.scriptsMap.keys()].map((p) => this.dto(p));
  }
  async script(_id: string, path: string) {
    this.guard();
    if (!this.scriptsMap.has(path)) throw new CloudError(404, 'NOT_FOUND', 'script not found');
    return this.dto(path);
  }
  async putScript(_id: string, path: string, body: { source: string; baseVersion: number | null; origin: string }) {
    this.guard();
    this.puts.push({ path, baseVersion: body.baseVersion, origin: body.origin });
    if (body.source.includes('INVALID') && body.origin !== 'external') throw new CloudError(422, 'SCRIPT_INVALID', 'the script did not pass validation', { issues: [{ path: 'steps[0]', message: 'bad step' }] });
    const s = this.scriptsMap.get(path);
    const cur = s?.versions.at(-1);
    if (!s) {
      if (body.baseVersion) throw new CloudError(409, 'SCRIPT_CONFLICT', 'gone', { current: null });
    } else if (body.baseVersion !== cur!.version) {
      throw new CloudError(409, 'SCRIPT_CONFLICT', 'changed', { current: { version: cur!.version, source: cur!.source, author: { id: cur!.author, name: cur!.author }, createdAt: cur!.at } });
    } else if (scriptHash(cur!.source) === scriptHash(body.source)) {
      return { script: this.dto(path), version: {} as ScriptVersionDto, unchanged: true };
    }
    this.saveAs(this.user, path, body.source);
    return { script: this.dto(path), version: {} as ScriptVersionDto, unchanged: false };
  }
}

class FakeHost implements SyncHost {
  files = new Map<string, string>();
  notices: SyncNotice[] = [];
  snapshots: CloudSnapshot[] = [];
  offlineCalls = 0;
  readLocal = (p: string) => this.files.get(p);
  writeLocal = (p: string, t: string) => void this.files.set(p, t);
  deleteLocal = (p: string) => void this.files.delete(p);
  renameLocal = (a: string, b: string) => {
    this.files.set(b, this.files.get(a)!);
    this.files.delete(a);
  };
  listLocal = () => [...this.files.keys()];
  snapshotChanged = (s: CloudSnapshot) => void this.snapshots.push(s);
  notice = (n: SyncNotice) => void this.notices.push(n);
  changed = () => undefined;
  offline = () => void this.offlineCalls++;
  authLost = () => undefined;
  myUserId = () => ME;
  runEvents: string[] = [];
  runEvent = (kind: string, data: Record<string, unknown>) => void this.runEvents.push(`${kind}:${String(data.runId ?? '')}`);
}

let dir: string;
let server: FakeServer;
let host: FakeHost;
let wc: WorkingCopy;
let sync: ProjectSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'euta-sync-'));
  server = new FakeServer();
  host = new FakeHost();
  wc = new WorkingCopy(dir);
  wc.saveState({ schema: 1, serverUrl: 'http://cloud.test', projectId: PID, lastSeq: null, role: 'editor', can: [], scripts: {}, remoteNewer: {}, nextTicket: 1 });
  sync = new ProjectSync(wc, server, host);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A local save the way ProjectService does it: file first, then the queue. */
function save(path: string, text: string, origin: 'app' | 'ai_mcp' | 'external' = 'app') {
  host.files.set(path, text);
  return sync.enqueue(path, text, origin);
}

describe('ids', () => {
  it('maps cloud UUIDs to app ids and back', () => {
    expect(compactId(PID)).toBe('11111111222233334444555555555555');
    expect(expandId(compactId(PID))).toBe(PID);
    expect(() => compactId('nope')).toThrow();
  });
});

describe('saves and the pending queue', () => {
  it('online: a save becomes the new base version', async () => {
    const e = save('a.yaml', script('A'));
    expect(await sync.push(e.ticket, true)).toEqual({ kind: 'saved', version: 1, unchanged: false });
    expect(wc.state().scripts['a.yaml']).toMatchObject({ version: 1, hash: scriptHash(script('A')) });
    expect(wc.pending()).toEqual([]);
    const e2 = save('a.yaml', script('A', 'x'));
    expect(await sync.push(e2.ticket, true)).toMatchObject({ kind: 'saved', version: 2 });
    expect(server.puts.map((p) => p.baseVersion)).toEqual([null, 1]);
  });

  it('offline: saves wait in order and are sent in that order on reconnect (chained base versions)', async () => {
    server.down = true;
    const a1 = save('a.yaml', script('A1'));
    expect(await sync.push(a1.ticket, false)).toEqual({ kind: 'queued', reason: 'offline' });
    save('b.yaml', script('B'));
    save('a.yaml', script('A2'));
    expect(wc.pending().map((e) => [e.ticket, e.path])).toEqual([
      [1, 'a.yaml'],
      [2, 'b.yaml'],
      [3, 'a.yaml'],
    ]);
    await sync.drain();
    expect(host.offlineCalls).toBe(1);
    expect(wc.pending()).toHaveLength(3); // nothing lost
    server.down = false;
    await sync.drain();
    expect(server.puts.slice(-3).map((p) => `${p.path}@${p.baseVersion}`)).toEqual(['a.yaml@null', 'b.yaml@null', 'a.yaml@1']);
    expect(wc.pending()).toEqual([]);
    expect(server.dto('a.yaml').source).toBe(script('A2'));
    expect(host.notices).toContainEqual({ kind: 'sent', count: 3 });
  });

  it('a 409 stops the queue at that save; later saves wait until it is resolved', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    await sync.resync(5);
    server.saveAs(OTHER, 'a.yaml', script('A', 'other'));
    const mine = save('a.yaml', script('A', 'mine'));
    const later = save('b.yaml', script('B'));
    const out = await sync.push(mine.ticket, true);
    expect(out.kind).toBe('conflict');
    if (out.kind !== 'conflict') return;
    expect(out.entry.server).toMatchObject({ version: 2, source: script('A', 'other'), author: OTHER });
    expect(sync.blocked()?.ticket).toBe(mine.ticket);
    expect(await sync.push(later.ticket, true)).toEqual({ kind: 'queued', reason: 'blocked' });
    expect(server.scriptsMap.has('b.yaml')).toBe(false);
    expect(host.notices).toContainEqual({ kind: 'conflict', path: 'a.yaml', ticket: mine.ticket });

    // ① mine → a new version on top of the server's latest, then the queue continues.
    expect(await sync.resolve(mine.ticket, 'mine')).toBeUndefined();
    expect(server.dto('a.yaml')).toMatchObject({ version: 3, source: script('A', 'mine') });
    expect(server.puts.find((p) => p.path === 'a.yaml' && p.baseVersion === 2)).toBeTruthy();
    expect(server.scriptsMap.has('b.yaml')).toBe(true);
    expect(wc.pending()).toEqual([]);
  });

  it('② theirs takes the server version and drops my saves of that script', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    await sync.resync(1);
    server.saveAs(OTHER, 'a.yaml', script('A', 'other'));
    const mine = save('a.yaml', script('A', 'mine'));
    save('a.yaml', script('A', 'mine2'));
    await sync.push(mine.ticket, true);
    await sync.resolve(mine.ticket, 'theirs');
    expect(host.files.get('a.yaml')).toBe(script('A', 'other'));
    expect(wc.state().scripts['a.yaml']?.version).toBe(2);
    expect(wc.pending()).toEqual([]);
    expect(server.dto('a.yaml').version).toBe(2);
  });

  it('③ copy saves my text as a new script and the original takes the server version', async () => {
    server.saveAs(OTHER, 'login.yaml', script('L'));
    await sync.resync(1);
    server.saveAs(OTHER, 'login.yaml', script('L', 'other'));
    const mine = save('login.yaml', script('L', 'mine'));
    await sync.push(mine.ticket, true);
    await sync.resolve(mine.ticket, 'copy', 'login-me.yaml');
    expect(server.dto('login-me.yaml').source).toBe(script('L', 'mine'));
    expect(host.files.get('login-me.yaml')).toBe(script('L', 'mine'));
    expect(host.files.get('login.yaml')).toBe(script('L', 'other'));
    expect(wc.state().scripts['login-me.yaml']?.version).toBe(1);
    expect(wc.pending()).toEqual([]);
  });

  it('a conflict against a script deleted on the server: theirs removes it, mine re-creates it', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    await sync.resync(1);
    server.scriptsMap.delete('a.yaml');
    const mine = save('a.yaml', script('A', 'mine'));
    const out = await sync.push(mine.ticket, true);
    expect(out.kind === 'conflict' && out.entry.server).toBeNull();
    await sync.resolve(mine.ticket, 'mine');
    expect(server.dto('a.yaml').source).toBe(script('A', 'mine'));
  });

  it('a rejected save (422) blocks the queue; theirs discards it', async () => {
    const bad = save('x.yaml', 'INVALID');
    const out = await sync.push(bad.ticket, true);
    expect(out).toMatchObject({ kind: 'rejected' });
    expect(out.kind === 'rejected' && out.error).toContain('bad step');
    expect(sync.blocked()?.status).toBe('rejected');
    await sync.resolve(bad.ticket, 'theirs');
    expect(wc.pending()).toEqual([]);
    expect(host.files.has('x.yaml')).toBe(false); // never existed on the server
  });

  it('discarding a rejected save that has a later save of the same script sends the later one and keeps the file (ADR-046)', async () => {
    // A new script: the AI's first save is refused, its fixed save is queued behind it.
    const bad = save('new.yaml', 'INVALID');
    await sync.push(bad.ticket, true);
    const fixed = save('new.yaml', script('N', 'fixed'));
    const other = save('b.yaml', script('B'));
    expect(sync.blocked()?.ticket).toBe(bad.ticket);
    const gets = server.puts.length;
    await sync.resolve(bad.ticket, 'theirs');
    expect(wc.pending()).toEqual([]);
    expect(host.files.get('new.yaml')).toBe(script('N', 'fixed')); // not deleted (the server never had it)
    expect(server.dto('new.yaml')).toMatchObject({ version: 1, source: script('N', 'fixed') });
    expect(server.scriptsMap.has('b.yaml')).toBe(true); // the queue went on
    expect(server.puts.slice(gets).map((p) => `${p.path}@${p.baseVersion}`)).toEqual(['new.yaml@null', 'b.yaml@null']);
    expect([fixed.ticket, other.ticket].every((t) => !wc.pending().some((x) => x.ticket === t))).toBe(true);

    // An existing script: the later save goes on top of the server's version.
    const bad2 = save('new.yaml', 'INVALID again');
    await sync.push(bad2.ticket, true);
    save('new.yaml', script('N', 'fixed2'));
    await sync.resolve(bad2.ticket, 'theirs');
    expect(server.dto('new.yaml')).toMatchObject({ version: 2, source: script('N', 'fixed2') });
    expect(host.files.get('new.yaml')).toBe(script('N', 'fixed2'));
  });

  it('discarding a conflict still drops every save of that script (unchanged)', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    await sync.resync(1);
    server.saveAs(OTHER, 'a.yaml', script('A', 'other'));
    const mine = save('a.yaml', script('A', 'mine'));
    save('a.yaml', script('A', 'mine2'));
    await sync.push(mine.ticket, true);
    expect(sync.blocked()?.status).toBe('conflict');
    await sync.resolve(mine.ticket, 'theirs');
    expect(wc.pending()).toEqual([]);
    expect(host.files.get('a.yaml')).toBe(script('A', 'other'));
    expect(server.dto('a.yaml').version).toBe(2);
  });

  it('outside edits are sent with origin external (accepted even when invalid)', async () => {
    const e = save('x.yaml', 'INVALID: yes', 'external');
    expect((await sync.push(e.ticket, true)).kind).toBe('saved');
    expect(server.puts.at(-1)?.origin).toBe('external');
  });

  it('AI conflict: the server copy replaces the AI text at once', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    await sync.resync(1);
    server.saveAs(OTHER, 'a.yaml', script('A', 'other'));
    const ai = save('a.yaml', script('A', 'ai'), 'ai_mcp');
    expect((await sync.push(ai.ticket, true)).kind).toBe('conflict');
    await sync.dropForAi(ai.ticket);
    expect(host.files.get('a.yaml')).toBe(script('A', 'other'));
    expect(wc.state().scripts['a.yaml']?.version).toBe(2);
    expect(wc.pending()).toEqual([]);
  });
});

describe('change feed and resync', () => {
  it('applies other people’s saves, skips my own echo, keeps scripts with unsent saves', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    server.saveAs(OTHER, 'b.yaml', script('B'));
    await sync.resync(2);
    expect(host.files.get('a.yaml')).toBe(script('A'));

    // Someone else saves a.yaml → the working copy follows, with a notice.
    const v = server.saveAs(OTHER, 'a.yaml', script('A', 'v2'));
    await sync.apply({ event: 'change', seq: 3, kind: 'script.saved', actorId: OTHER, data: { path: 'a.yaml', version: v } });
    expect(host.files.get('a.yaml')).toBe(script('A', 'v2'));
    expect(host.notices).toContainEqual({ kind: 'remote-saved', path: 'a.yaml', version: 2, by: OTHER, pending: false });
    expect(wc.state().lastSeq).toBe(3);

    // My own save comes back on the feed → nothing to do.
    const e = save('a.yaml', script('A', 'mine'));
    await sync.push(e.ticket, true);
    await sync.drain(); // let the send round finish (its "sent" notice)
    const before = host.notices.length;
    await sync.apply({ event: 'change', seq: 4, kind: 'script.saved', actorId: ME, data: { path: 'a.yaml', version: 3 } });
    expect(host.notices.length).toBe(before);

    // Offline edit of b.yaml, then someone else saves b.yaml → my file stays, marked newer.
    server.down = true;
    save('b.yaml', script('B', 'mine'));
    server.down = false;
    const vb = server.saveAs(OTHER, 'b.yaml', script('B', 'other'));
    await sync.apply({ event: 'change', seq: 5, kind: 'script.saved', actorId: OTHER, data: { path: 'b.yaml', version: vb } });
    expect(host.files.get('b.yaml')).toBe(script('B', 'mine'));
    expect(wc.state().remoteNewer['b.yaml']).toEqual({ version: 2 });
  });

  it('follows renames and deletions; settings changes refresh the snapshot', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    server.saveAs(OTHER, 'c.yaml', script('C'));
    await sync.resync(1);
    await sync.apply({ event: 'change', seq: 2, kind: 'script.renamed', actorId: OTHER, data: { from: 'a.yaml', to: 'z.yaml' } });
    expect(host.files.has('a.yaml')).toBe(false);
    expect(host.files.get('z.yaml')).toBe(script('A'));
    expect(wc.state().scripts['z.yaml']?.version).toBe(1);
    await sync.apply({ event: 'change', seq: 3, kind: 'script.deleted', actorId: OTHER, data: { path: 'c.yaml' } });
    expect(host.files.has('c.yaml')).toBe(false);
    const n = host.snapshots.length;
    await sync.apply({ event: 'change', seq: 4, kind: 'environment.created', actorId: OTHER, data: {} });
    expect(host.snapshots.length).toBe(n + 1);
    // run.* / schedule.* touch nothing in the working copy — they go to the host (C3: Live, History, 예약)
    const files = [...host.files.keys()];
    await sync.apply({ event: 'change', seq: 5, kind: 'run.started', actorId: OTHER, data: { runId: 'r1' } });
    await sync.apply({ event: 'change', seq: 6, kind: 'schedule.created', actorId: OTHER, data: {} });
    expect(wc.state().lastSeq).toBe(6);
    expect([...host.files.keys()]).toEqual(files);
    expect(host.runEvents).toEqual(['run.started:r1', 'schedule.created:']);
  });

  it('resync replaces the working copy from the server but keeps pending saves', async () => {
    server.saveAs(OTHER, 'a.yaml', script('A'));
    server.saveAs(OTHER, 'gone.yaml', script('G'));
    await sync.resync(1);
    server.down = true;
    save('a.yaml', script('A', 'offline'));
    server.down = false;
    server.scriptsMap.delete('gone.yaml');
    server.saveAs(OTHER, 'new.yaml', script('N'));
    server.saveAs(OTHER, 'a.yaml', script('A', 'other'));
    await sync.resync(42);
    expect(host.files.has('gone.yaml')).toBe(false);
    expect(host.files.get('new.yaml')).toBe(script('N'));
    expect(host.files.get('a.yaml')).toBe(script('A', 'offline'));
    expect(wc.state().remoteNewer['a.yaml']).toEqual({ version: 2 });
    expect(wc.state().lastSeq).toBe(42);
    expect(wc.pending()).toHaveLength(1);
    // Sending it now meets the newer server version → conflict.
    await sync.drain();
    expect(sync.blocked()?.status).toBe('conflict');
  });
});

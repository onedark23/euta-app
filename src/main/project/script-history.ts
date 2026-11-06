// Script version history (SPEC 스크립트-보기-편집 "저장과 변경 이력", ADR-018):
//   <project>/script-history/keys.json            { paths: { <rel>: <scriptKey> }, deleted: [...] }
//   <project>/script-history/<scriptKey>/index.json   [{ version, at, actor, kind, path, hash, summary }]
//   <project>/script-history/<scriptKey>/<version>.yaml  full content at that version (verbatim)
// A version is the content *after* a change, tagged with who made it. `scriptKey` is fixed per
// script, so renames keep the history; deleted scripts keep theirs and can be restored.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, scriptHash } from '@euta/core';
import type { DeletedScript, ScriptHistoryActor, ScriptHistoryKind, ScriptVersionView } from '../../shared/types.js';
import { diffScripts } from '../../shared/script-diff.js';
import { isId, newId, readJson, writeJsonAtomic } from './fsx.js';

export const MAX_VERSIONS = 100;
const ACTORS = new Set<ScriptHistoryActor>(['user', 'ai', 'recording', 'external', 'restore']);

interface KeysFile {
  paths: Record<string, string>;
  deleted: DeletedScript[];
}

export function parseScript(text: string): unknown {
  const r = parseYaml(text);
  return r.issues.length ? undefined : r.value;
}

/** Diff summary of `after` against `before` (undefined = first version). */
export function changeSummary(before: string | undefined, after: string): string {
  const b = before === undefined ? undefined : (parseScript(before) ?? {});
  const a = parseScript(after);
  if (a === undefined) return before === undefined ? '처음 기록 (YAML 오류)' : 'YAML 오류가 있는 내용으로 바뀜';
  return diffScripts(b, a).summary;
}

export class ScriptHistory {
  readonly dir: string;

  constructor(
    projectDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = join(projectDir, 'script-history');
  }

  private keysFile(): string {
    return join(this.dir, 'keys.json');
  }

  private readKeys(): KeysFile {
    const k = readJson<Partial<KeysFile>>(this.keysFile());
    const paths: Record<string, string> = {};
    for (const [p, key] of Object.entries(k?.paths ?? {})) if (typeof p === 'string' && isId(key)) paths[p] = key;
    const deleted = Array.isArray(k?.deleted) ? k.deleted.filter((d) => d && isId(d.key) && typeof d.path === 'string') : [];
    return { paths, deleted };
  }

  private writeKeys(k: KeysFile): void {
    writeJsonAtomic(this.keysFile(), k);
  }

  /** The script's key, or undefined when it has no history yet. */
  keyOf(rel: string): string | undefined {
    return this.readKeys().paths[rel];
  }

  /** Current library path of a key (undefined when deleted / unknown). */
  pathOf(key: string): string | undefined {
    return Object.entries(this.readKeys().paths).find(([, k]) => k === key)?.[0];
  }

  private ensureKey(rel: string): string {
    const k = this.readKeys();
    let key = k.paths[rel];
    if (!key) {
      do key = newId(12);
      while (existsSync(join(this.dir, key)));
      k.paths[rel] = key;
      this.writeKeys(k);
    }
    return key;
  }

  versions(key: string): ScriptVersionView[] {
    if (!isId(key)) return [];
    const list = readJson<ScriptVersionView[]>(join(this.dir, key, 'index.json'));
    return Array.isArray(list) ? list.filter((v) => v && Number.isInteger(v.version) && typeof v.hash === 'string' && ACTORS.has(v.actor)) : [];
  }

  latest(key: string): ScriptVersionView | undefined {
    return this.versions(key).at(-1);
  }

  content(key: string, version: number): string | undefined {
    if (!isId(key) || !Number.isInteger(version)) return undefined;
    try {
      return readFileSync(join(this.dir, key, `${version}.yaml`), 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Append a version for `rel` with `content`. Same content as the latest version is not
   * recorded again unless `force` (rename / delete / restore entries).
   */
  record(rel: string, content: string, actor: ScriptHistoryActor, kind: ScriptHistoryKind, o: { summary?: string; force?: boolean } = {}): ScriptVersionView | undefined {
    const key = this.ensureKey(rel);
    const list = this.versions(key);
    const last = list.at(-1);
    const hash = scriptHash(content);
    if (last && last.hash === hash && !o.force) return undefined;
    const prev = last ? this.content(key, last.version) : undefined;
    const v: ScriptVersionView = {
      version: (last?.version ?? 0) + 1,
      at: this.now().toISOString(),
      actor,
      kind,
      path: rel,
      hash,
      summary: o.summary ?? changeSummary(prev, content),
    };
    const dir = join(this.dir, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${v.version}.yaml`), content, { mode: 0o600 });
    list.push(v);
    // Keep the newest MAX_VERSIONS.
    const drop = list.length - MAX_VERSIONS;
    if (drop > 0) for (const old of list.splice(0, drop)) rmSync(join(dir, `${old.version}.yaml`), { force: true });
    writeJsonAtomic(join(dir, 'index.json'), list);
    return v;
  }

  /**
   * Make the history match what is on disk: a first `baseline` version for a script without
   * history, or an `external` version when the file differs from the latest version.
   */
  sync(rel: string, disk: string, actor: ScriptHistoryActor = 'external'): ScriptVersionView | undefined {
    const key = this.keyOf(rel);
    const last = key ? this.latest(key) : undefined;
    if (last && last.hash === scriptHash(disk)) return undefined;
    return this.record(rel, disk, actor, last ? 'external' : 'baseline');
  }

  /** The key follows the script to its new path; a `rename` entry is recorded. */
  rename(from: string, to: string, content: string | undefined, actor: ScriptHistoryActor = 'user'): void {
    const k = this.readKeys();
    const key = k.paths[from];
    if (!key) {
      if (content !== undefined) this.record(to, content, actor, 'baseline');
      return;
    }
    delete k.paths[from];
    k.paths[to] = key;
    this.writeKeys(k);
    const body = content ?? (this.latest(key) ? this.content(key, this.latest(key)!.version) : undefined);
    if (body !== undefined) this.record(to, body, actor, 'rename', { force: true, summary: `이름 변경: ${from} → ${to}` });
  }

  /** The script was deleted: keep its last content and list it under 삭제된 스크립트. */
  remove(rel: string, content: string | undefined, actor: ScriptHistoryActor = 'user', name?: string): void {
    const k0 = this.readKeys();
    if (!k0.paths[rel] && content === undefined) return;
    const key = this.ensureKey(rel);
    const last = this.latest(key);
    const body = content ?? (last ? this.content(key, last.version) : undefined);
    if (body === undefined) return;
    if (!last || last.hash !== scriptHash(body)) this.record(rel, body, actor, last ? 'external' : 'baseline');
    this.record(rel, body, actor, 'delete', { force: true, summary: `삭제: ${rel}` });
    const k = this.readKeys();
    delete k.paths[rel];
    k.deleted = [{ key, path: rel, ...(name ? { name } : {}), at: this.now().toISOString() }, ...k.deleted.filter((d) => d.key !== key)].slice(0, 500);
    this.writeKeys(k);
  }

  deleted(): DeletedScript[] {
    return this.readKeys().deleted;
  }

  /** Last content of a deleted script (to restore it). */
  deletedContent(key: string): { entry: DeletedScript; content: string } | undefined {
    const entry = this.readKeys().deleted.find((d) => d.key === key);
    const last = entry ? this.latest(key) : undefined;
    const content = last ? this.content(key, last.version) : undefined;
    return entry && content !== undefined ? { entry, content } : undefined;
  }

  /** Re-attach a deleted script's key to `rel` (before the restored file is written). */
  attach(key: string, rel: string): void {
    const k = this.readKeys();
    k.deleted = k.deleted.filter((d) => d.key !== key);
    for (const [p, v] of Object.entries(k.paths)) if (v === key) delete k.paths[p];
    k.paths[rel] = key;
    this.writeKeys(k);
  }

  /** Key of the script (with history) whose latest content hash is `hash` among `paths`. */
  matchByHash(paths: string[], hash: string): string | undefined {
    const k = this.readKeys();
    return paths.find((p) => {
      const key = k.paths[p];
      return key && this.latest(key)?.hash === hash;
    });
  }
}

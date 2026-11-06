// Project script library: YAML files under <project>/scripts (subfolders allowed).
// List (name, path, last run from the project's index.sqlite), import checks, rename,
// delete, export (content writes go through ProjectService.writeScript — ADR-018), and a debounced recursive watcher so outside edits (editor, AI chat)
// refresh the list.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RunIndex } from '@euta/core';
import type { ScriptEntry } from '../../shared/types.js';
import { cleanScriptPath, InputError } from './project-store.js';

const MAX_SCRIPTS = 2000;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

export const NEW_SCRIPT_TEMPLATE = (name: string): string => `# euta test script. BASE_URL comes from the selected project environment.
version: 1
name: ${JSON.stringify(name)}
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /
  - expect: { visible: { role: heading } }
`;

export function scriptName(source: string): string | undefined {
  return /^name:\s*(.+)$/m.exec(source)?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
}

export class ScriptLibrary {
  constructor(
    readonly scriptsDir: string,
    private readonly runsDir: string,
  ) {}

  /** Absolute path of a library-relative path (validated, stays inside scripts/). */
  abs(rel: string): string {
    const clean = cleanScriptPath(rel);
    const p = resolve(this.scriptsDir, clean);
    if (!p.startsWith(resolve(this.scriptsDir) + sep)) throw new InputError('script path escapes the scripts folder');
    return p;
  }

  /** Library-relative path of an absolute path inside scripts/, else undefined. */
  rel(absPath: string): string | undefined {
    const r = relative(resolve(this.scriptsDir), resolve(absPath));
    if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return undefined;
    return r.split(sep).join('/');
  }

  list(): ScriptEntry[] {
    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || files.length >= MAX_SCRIPTS) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names.sort()) {
        if (n.startsWith('.') || n === 'node_modules') continue;
        const p = join(dir, n);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (st.isFile() && /\.ya?ml$/i.test(n)) files.push(p);
      }
    };
    if (existsSync(this.scriptsDir)) walk(this.scriptsDir, 0);
    const last = this.lastRuns();
    return files.map((p) => {
      let name: string | undefined;
      let mtimeMs = 0;
      try {
        const st = statSync(p);
        mtimeMs = st.mtimeMs;
        if (st.size <= MAX_SCRIPT_BYTES) name = scriptName(readFileSync(p, 'utf8'));
      } catch {
        /* unreadable: list without a name */
      }
      const lr = last.get(resolve(p));
      return { path: relative(this.scriptsDir, p).split(sep).join('/'), ...(name ? { name } : {}), mtimeMs, ...(lr ? { lastRun: lr } : {}) };
    });
  }

  /** Latest run per absolute script path (from the project's index.sqlite). */
  private lastRuns(): Map<string, { runId: string; status: string; startedAt: string }> {
    const m = new Map<string, { runId: string; status: string; startedAt: string }>();
    if (!existsSync(join(this.runsDir, 'index.sqlite'))) return m;
    try {
      const runs = RunIndex.with(this.runsDir, (idx) => idx.listRuns({ limit: 1000 }));
      for (const r of runs) {
        if (!r.scriptPath) continue;
        const k = resolve(r.scriptPath);
        if (!m.has(k)) m.set(k, { runId: r.id, status: r.status, startedAt: r.startedAt }); // newest first
      }
    } catch {
      /* index unreadable: no statuses */
    }
    return m;
  }

  /** A free library path: `base.yaml`, `base-2.yaml`, ... */
  freePath(rel: string): string {
    const clean = cleanScriptPath(rel);
    if (!existsSync(this.abs(clean))) return clean;
    const ext = extname(clean);
    const stem = clean.slice(0, -ext.length);
    for (let i = 2; i < 1000; i++) {
      const cand = `${stem}-${i}${ext}`;
      if (!existsSync(this.abs(cand))) return cand;
    }
    throw new InputError('too many files with this name');
  }

  /** Validate an external YAML file for import; returns a free library path and its text (the caller writes it). */
  readImport(source: string, targetDir = ''): { rel: string; content: string } {
    if (!/\.ya?ml$/i.test(source)) throw new InputError('only .yaml / .yml files can be imported');
    const st = statSync(source);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) throw new InputError('not a script file (or too large)');
    const rel = this.freePath(`${targetDir ? `${targetDir.replace(/\/+$/, '')}/` : ''}${basename(source)}`);
    return { rel, content: readFileSync(source, 'utf8') };
  }

  rename(from: string, to: string): string {
    const a = this.abs(from);
    if (!existsSync(a)) throw new InputError('script not found');
    const toClean = cleanScriptPath(to);
    const b = this.abs(toClean);
    if (existsSync(b)) throw new InputError('a script with that name already exists');
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
    return toClean;
  }

  delete(rel: string): void {
    const p = this.abs(rel);
    if (!existsSync(p)) throw new InputError('script not found');
    rmSync(p);
  }

  /** Copy a library script to an absolute destination chosen by the user. */
  export(rel: string, dest: string): void {
    const p = this.abs(rel);
    if (!existsSync(p)) throw new InputError('script not found');
    copyFileSync(p, dest);
  }

  /**
   * Watch scripts/ recursively; `onChange` gets the changed library paths after a
   * debounce. Returns a close function. Watch errors stop watching silently.
   */
  watch(onChange: (paths: string[]) => void, debounceMs = 250): () => void {
    mkdirSync(this.scriptsDir, { recursive: true });
    const changed = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    let w: FSWatcher | undefined;
    try {
      w = watch(this.scriptsDir, { recursive: true }, (_ev, file) => {
        const f = typeof file === 'string' ? file.split(sep).join('/') : '';
        if (f && f.split('/').some((s) => s.startsWith('.'))) return;
        if (f && !/\.ya?ml$/i.test(f) && extname(f)) return;
        changed.add(f);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const list = [...changed].filter(Boolean);
          changed.clear();
          onChange(list);
        }, debounceMs);
      });
      w.on('error', () => w?.close());
    } catch {
      /* platform without recursive watch: the list refreshes on demand */
    }
    return () => {
      if (timer) clearTimeout(timer);
      w?.close();
    };
  }
}

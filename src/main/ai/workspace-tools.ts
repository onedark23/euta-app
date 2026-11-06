// File tools for the AI chat, scoped to the working folder. They replace Claude Code's
// built-in Read/Glob/Write (disabled, ADR-015) so that every result passes through
// euta's SecretGuard and nothing outside the folder, hidden, or credential-like is read.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { collectRefs, parseYaml, validateScript, type ScriptInputs, type ValidationIssue } from '@euta/core';
import { isInside, text, ToolError, type EutaTool, type EutaTools } from '@euta/mcp-server/tools';

const READ_EXT = new Set(['.yaml', '.yml', '.json', '.txt', '.md', '.csv', '.tsv', '.log', '.html', '.htm', '.xml']);
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Applications', '$RECYCLE.BIN', 'AppData']);
/** Names that look like credentials/keys even when not hidden. */
const SENSITIVE_NAME = /(secret|credential|password|passwd|token|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519|\.env$|^\.env)/i;
const MAX_READ = 200_000;
const MAX_ENTRIES = 400;

export interface WorkspaceToolsOptions {
  workDir: string;
  /** Configured secrets file: never readable, even inside the folder. */
  secretsFile?: string;
  inputs: () => ScriptInputs;
  /** Write a script through the app's history-aware path (ADR-018); default: plain write. */
  writeScript?: (absPath: string, content: string) => void | Promise<void>;
  /** Called with what read_file returned (before masking). */
  onRead?: (absPath: string, text: string) => void;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve `p` (relative to workDir) and require it to stay inside workDir after
 * following symlinks, with no hidden segment and no credential-like name.
 */
export function resolveInWorkspace(workDir: string, p: string, opts: { mustExist: boolean; secretsFile?: string }): string {
  const root = realOrSelf(resolve(workDir));
  const abs = resolve(root, p);
  if (!isInside(root, abs)) throw new ToolError(`path must be inside the working folder ${root}: ${p}`);
  const rel = relative(root, abs);
  const segments = rel ? rel.split(sep) : [];
  if (segments.some((s) => s.startsWith('.'))) throw new ToolError(`hidden files and folders are not accessible: ${p}`);
  if (segments.length && SENSITIVE_NAME.test(segments[segments.length - 1]!)) throw new ToolError(`this file name looks like a credential and is not accessible: ${p}`);
  const target = opts.mustExist ? abs : dirname(abs);
  if (opts.mustExist && !existsSync(abs)) throw new ToolError(`not found: ${p}`);
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!isInside(root, real)) throw new ToolError(`path escapes the working folder (symlink): ${p}`);
  }
  if (opts.secretsFile && existsSync(opts.secretsFile) && existsSync(abs) && realOrSelf(abs) === realOrSelf(opts.secretsFile)) {
    throw new ToolError('the secrets file is never readable by the AI');
  }
  return abs;
}

/**
 * The save-time check of the euta cloud server (script-check.ts): YAML must parse, schema and
 * reference syntax must pass; `${env.*}` / `${secrets.*}` values are environment matters and get a
 * placeholder. The AI's save_script runs it BEFORE writing, so a script the server would refuse
 * never reaches the library or the cloud send queue (SPEC TC-문서-변환 2026-11-05, ADR-046).
 */
export function saveCheck(source: string): ValidationIssue[] {
  const parsed = parseYaml(source);
  if (parsed.issues.length) return parsed.issues;
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path: '', message: 'script must be a YAML mapping (version, name, steps, ...)' }];
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const r of collectRefs(value)) {
    if (r.ns === 'secrets') secrets[r.key] = 'placeholder';
    else if (r.ns === 'env') env[r.key] = 'placeholder';
  }
  return validateScript(source, { env, secrets });
}

export function createWorkspaceTools(t: EutaTools, o: WorkspaceToolsOptions): EutaTool[] {
  const root = (): string => realOrSelf(resolve(o.workDir));
  const where = `Working folder: ${resolve(o.workDir)}.`;

  const list = t.define({
    name: 'list_files',
    title: 'List files in the working folder',
    description: `List files and folders in the working folder (or a subfolder), e.g. to find YAML scripts. Hidden entries are skipped. ${where}`,
    inputShape: {
      dir: z.string().optional().describe('Subfolder relative to the working folder (default: the folder itself).'),
      depth: z.number().int().min(1).max(4).optional().describe('How many levels to descend (default 2).'),
      pattern: z.string().optional().describe('Only files whose name ends with this suffix, e.g. ".yaml".'),
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const base = resolveInWorkspace(o.workDir, a.dir ?? '.', { mustExist: true, ...(o.secretsFile ? { secretsFile: o.secretsFile } : {}) });
      if (!statSync(base).isDirectory()) throw new ToolError(`not a folder: ${a.dir}`);
      const out: { path: string; type: 'file' | 'dir'; size?: number }[] = [];
      let truncated = false;
      const walk = (dir: string, depth: number): void => {
        let names: string[];
        try {
          names = readdirSync(dir).sort();
        } catch {
          return;
        }
        for (const n of names) {
          if (out.length >= MAX_ENTRIES) {
            truncated = true;
            return;
          }
          if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
          const p = join(dir, n);
          let st;
          try {
            st = statSync(p);
          } catch {
            continue;
          }
          const rel = relative(root(), p);
          if (st.isDirectory()) {
            if (!a.pattern) out.push({ path: rel + '/', type: 'dir' });
            if (depth > 1) walk(p, depth - 1);
          } else if (!a.pattern || n.endsWith(a.pattern)) {
            out.push({ path: rel, type: 'file', size: st.size });
          }
        }
      };
      walk(base, a.depth ?? 2);
      return [text({ root: root(), entries: out, ...(truncated ? { truncated: true } : {}) })];
    },
  });

  const read = t.define({
    name: 'read_file',
    title: 'Read a text file in the working folder',
    description: `Read a text file (yaml, json, txt, md, csv, html, log) inside the working folder. Size-capped; output is masked with the configured secrets. Hidden and credential-like files are refused. ${where}`,
    inputShape: {
      path: z.string().describe('File path relative to the working folder (or absolute inside it).'),
      maxChars: z.number().int().min(1).max(MAX_READ).optional().describe(`Max characters (default ${MAX_READ}).`),
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const p = resolveInWorkspace(o.workDir, a.path, { mustExist: true, ...(o.secretsFile ? { secretsFile: o.secretsFile } : {}) });
      if (!statSync(p).isFile()) throw new ToolError(`not a file: ${a.path}`);
      if (!READ_EXT.has(extname(p).toLowerCase())) throw new ToolError(`only text files can be read (${[...READ_EXT].join(', ')}): ${basename(p)}`);
      const body = readFileSync(p, 'utf8');
      const max = a.maxChars ?? MAX_READ;
      const truncated = body.length > max;
      t.guard.note(body);
      o.onRead?.(p, body);
      return [text({ path: relative(root(), p), size: body.length, truncated }), text(truncated ? body.slice(0, max) : body)];
    },
  });

  const save = t.define({
    name: 'save_script',
    title: 'Save a YAML test script in the working folder',
    description: `Write a euta YAML script (.yaml/.yml) inside the working folder. The script is validated FIRST (YAML, schema, reference syntax): on issues nothing is saved and you get the issues — fix them and save again. Refuses to replace an existing file unless overwrite is true. Use \${secrets.NAME} references, never secret values. Returns { savedTo, valid, issues } (issues = what is still missing in the chat environment, e.g. an unset secret). ${where}`,
    inputShape: {
      path: z.string().describe('Target file, relative to the working folder, ending in .yaml or .yml.'),
      yaml: z.string().describe('Full script text.'),
      overwrite: z.boolean().optional(),
    },
    async run(a) {
      if (!/\.ya?ml$/i.test(a.path)) throw new ToolError('path must end in .yaml or .yml');
      const p = resolveInWorkspace(o.workDir, a.path, { mustExist: false });
      if (existsSync(p) && !a.overwrite) throw new ToolError(`file exists: ${relative(root(), p)} (pass overwrite: true to replace)`);
      const envIssues = t.guard.envIssues(a.yaml);
      if (envIssues.length) throw new ToolError('script rejected (credential-like ${env.*} reference)', envIssues);
      // Validate before anything is written (a cloud project would otherwise queue a save the server refuses).
      const invalid = saveCheck(a.yaml);
      if (invalid.length) throw new ToolError('script NOT saved: it does not validate — fix the issues and call save_script again', invalid);
      const body = a.yaml.endsWith('\n') ? a.yaml : `${a.yaml}\n`;
      if (o.writeScript) {
        // A cloud save conflict / rejection becomes the tool result the AI reads (SPEC 클라우드-앱-연동).
        try {
          await o.writeScript(p, body);
        } catch (e) {
          throw e instanceof ToolError ? e : new ToolError((e as Error).message);
        }
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body);
      }
      const issues = validateScript(a.yaml, o.inputs());
      return [text({ savedTo: p, valid: issues.length === 0, issues })];
    },
  });

  return [list, read, save];
}

// Projects: <userData>/projects/<id>/project.json = Project + Environment[] + Suite[]
// (SPEC 프로젝트-관리). Loaded once, written atomically on every change.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { BrowserEngine, Environment, Project, ProjectBrowser, ProjectCloudLink, Suite } from '../../shared/types.js';
import { isId, newId, readJson, writeJsonAtomic } from './fsx.js';
import { MAX_ALLOWED_DOMAINS, parseDomains } from '../../shared/secret-rules.js';

export const PROJECT_SUBDIRS = ['scripts', 'baselines', 'runs', 'suite-runs', 'chats', 'activity'] as const;

const ENGINES = new Set<BrowserEngine>(['chromium', 'firefox', 'webkit']);
const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Same rule as the engine's MCP config: credential-like keys must be secrets (masked), not env vars. */
export const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH)/i;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function cleanName(v: unknown, what: string): string {
  const s = str(v, 80).replace(/[\u0000-\u001f]/g, '');
  if (!s) throw new InputError(`${what} name is required`);
  return s;
}

export function cleanBaseUrl(v: unknown): string {
  const s = str(v, 2000);
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new InputError('base URL must be an absolute http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InputError('base URL must be an absolute http(s) URL');
  if (u.username || u.password) throw new InputError('do not put credentials in the base URL — use secrets');
  return s;
}

/** Allowed domains from the settings form (array or comma/space text) → cleaned hosts; invalid entries are refused. */
export function cleanDomains(v: unknown): string[] {
  const text = Array.isArray(v) ? v.map((x) => String(x)).join(',') : str(v, 4000);
  const { domains, invalid } = parseDomains(text);
  if (invalid.length) throw new InputError(`허용 도메인은 호스트 이름이어야 합니다 (예: example.com): ${invalid.join(', ')}`);
  if (domains.length > MAX_ALLOWED_DOMAINS) throw new InputError(`허용 도메인은 ${MAX_ALLOWED_DOMAINS}개까지입니다`);
  return domains;
}

export function cleanVars(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!VAR_KEY.test(k)) throw new InputError(`invalid variable name: ${k}`);
    if (SENSITIVE_KEY.test(k)) throw new InputError(`"${k}" looks like a credential — store it as a secret, not a variable`);
    out[k] = typeof val === 'string' ? val.slice(0, 4000) : String(val ?? '');
  }
  return out;
}

/** Script path relative to scripts/: no absolute path, no "..", .yaml/.yml only. */
export function cleanScriptPath(v: unknown): string {
  const s = str(v, 500).replace(/\\/g, '/');
  if (!s || isAbsolute(s) || s.startsWith('/')) throw new InputError('script path must be relative to the scripts folder');
  const n = normalize(s).split(sep).join('/');
  if (n.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) throw new InputError(`invalid script path: ${s}`);
  if (!/\.ya?ml$/i.test(n)) throw new InputError('script must be a .yaml or .yml file');
  return n;
}

function cleanBrowser(v: unknown, cur: ProjectBrowser): ProjectBrowser {
  const b = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const engine = typeof b.engine === 'string' && ENGINES.has(b.engine as BrowserEngine) ? (b.engine as BrowserEngine) : cur.engine;
  const device = b.device === undefined ? cur.device : str(b.device, 80);
  const headless = typeof b.headless === 'boolean' ? b.headless : cur.headless;
  return { engine, ...(device ? { device } : {}), headless };
}

function reviveCloud(v: unknown): ProjectCloudLink | undefined {
  const c = (v && typeof v === 'object' ? v : undefined) as Record<string, unknown> | undefined;
  return c && typeof c.serverUrl === 'string' && typeof c.serverId === 'string' && typeof c.projectId === 'string' ? { serverUrl: c.serverUrl, serverId: c.serverId, projectId: c.projectId } : undefined;
}

function reviveUploaded(v: unknown): Project['uploadedTo'] {
  const u = (v && typeof v === 'object' ? v : undefined) as Record<string, unknown> | undefined;
  return u && typeof u.serverUrl === 'string' && typeof u.projectId === 'string' && isId(u.localId) && typeof u.name === 'string' && typeof u.at === 'string'
    ? { serverUrl: u.serverUrl, projectId: u.projectId, localId: u.localId, name: u.name, at: u.at }
    : undefined;
}

/** "항상 실행" paths: strings that are in the suite's list, once each (absent / junk → none). */
function alwaysRunOf(v: unknown, scripts: string[]): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((p): p is string => typeof p === 'string' && scripts.includes(p)))];
}

function reviveProject(raw: unknown, id: string): Project | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.id !== id || typeof r.name !== 'string') return undefined;
  const cloud = reviveCloud(r.cloud);
  const uploadedTo = reviveUploaded(r.uploadedTo);
  const envs = Array.isArray(r.environments) ? (r.environments as Environment[]).filter((e) => e && isId(e.id) && typeof e.name === 'string') : [];
  const suites = Array.isArray(r.suites) ? (r.suites as Suite[]).filter((s) => s && isId(s.id) && typeof s.name === 'string' && Array.isArray(s.scripts)) : [];
  return {
    id,
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    ...(isId(r.defaultEnvId) && envs.some((e) => e.id === r.defaultEnvId) ? { defaultEnvId: r.defaultEnvId } : {}),
    browser: cleanBrowser(r.browser, { engine: 'chromium', headless: true }),
    pinned: r.pinned === true,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    lastOpenedAt: typeof r.lastOpenedAt === 'string' ? r.lastOpenedAt : new Date(0).toISOString(),
    environments: envs.map((e) => ({
      id: e.id,
      name: e.name,
      baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : '',
      vars: e.vars && typeof e.vars === 'object' ? { ...e.vars } : {},
      secretNames: Array.isArray(e.secretNames) ? e.secretNames.filter((n) => typeof n === 'string') : [],
      ...(typeof e.secretsFile === 'string' && e.secretsFile && isAbsolute(e.secretsFile) ? { secretsFile: e.secretsFile } : {}),
      ...(Array.isArray(e.allowedDomains) ? { allowedDomains: e.allowedDomains.filter((d): d is string => typeof d === 'string').slice(0, MAX_ALLOWED_DOMAINS) } : {}),
    })),
    suites: suites.map((s) => {
      const scripts = s.scripts.filter((p) => typeof p === 'string');
      const always = alwaysRunOf(s.alwaysRun, scripts);
      return { id: s.id, name: s.name, scripts, ...(isId(s.envId) ? { envId: s.envId } : {}), stopOnFailure: s.stopOnFailure === true, ...(always.length ? { alwaysRun: always } : {}) };
    }),
    ...(cloud ? { cloud } : {}),
    ...(uploadedTo ? { uploadedTo } : {}),
  };
}

export interface EnvInput {
  name?: unknown;
  baseUrl?: unknown;
  vars?: unknown;
  /** Absolute path, or '' to use the vault. */
  secretsFile?: unknown;
  /** Hosts for secret input (list or comma text); null = back to the address-host default. */
  allowedDomains?: unknown;
}

export interface SuiteInput {
  name?: unknown;
  scripts?: unknown;
  envId?: unknown;
  stopOnFailure?: unknown;
  /** "항상 실행" script paths (must be in `scripts`; others are dropped). */
  alwaysRun?: unknown;
}

export class ProjectStore {
  readonly root: string;
  /** Cloud working copies: <userData>/cloud/<serverId>/projects/<cloud projectId>/ (SPEC 클라우드-앱-연동). */
  readonly cloudRoot: string;
  private readonly projects = new Map<string, Project>();
  /** Folders of cloud working copies (local projects live under root/<id>). */
  private readonly cloudDirs = new Map<string, string>();

  constructor(
    userData: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = join(userData, 'projects');
    this.cloudRoot = join(userData, 'cloud');
    if (existsSync(this.root)) {
      for (const id of readdirSync(this.root)) {
        if (!isId(id)) continue;
        const p = reviveProject(readJson(join(this.root, id, 'project.json')), id);
        if (p && !p.cloud) this.projects.set(id, p);
      }
    }
    if (existsSync(this.cloudRoot)) {
      for (const server of readdirSync(this.cloudRoot)) {
        const projectsDir = join(this.cloudRoot, server, 'projects');
        if (!/^[0-9a-f]{12}$/.test(server) || !existsSync(projectsDir)) continue;
        for (const cloudId of readdirSync(projectsDir)) {
          const dir = join(projectsDir, cloudId);
          const raw = readJson<{ id?: unknown }>(join(dir, 'project.json'));
          const id = typeof raw?.id === 'string' ? raw.id : '';
          const p = isId(id) ? reviveProject(raw, id) : undefined;
          if (!p?.cloud || p.cloud.projectId !== cloudId || this.projects.has(id)) continue;
          this.projects.set(id, p);
          this.cloudDirs.set(id, dir);
        }
      }
    }
  }

  dir(id: string): string {
    if (!isId(id)) throw new InputError('invalid project id');
    return this.cloudDirs.get(id) ?? join(this.root, id);
  }

  isCloud(id: string): boolean {
    return this.cloudDirs.has(id);
  }

  /** Folder of a cloud working copy (created on first use). */
  cloudDir(serverId: string, cloudProjectId: string): string {
    if (!/^[0-9a-f]{12}$/.test(serverId) || !/^[0-9a-f-]{36}$/.test(cloudProjectId)) throw new InputError('invalid cloud project');
    return join(this.cloudRoot, serverId, 'projects', cloudProjectId);
  }

  /** Register / replace a cloud working copy's project (derived from the server snapshot + this PC's preferences). */
  putCloud(p: Project, dir: string): Project {
    if (!p.cloud || !isId(p.id)) throw new InputError('not a cloud project');
    const existing = this.projects.get(p.id);
    if (existing && !existing.cloud) throw new InputError('id collision with a local project');
    for (const d of PROJECT_SUBDIRS) mkdirSync(join(dir, d), { recursive: true });
    this.cloudDirs.set(p.id, dir);
    this.projects.set(p.id, structuredClone(p));
    this.save(p);
    return structuredClone(p);
  }

  /** "클라우드로 올림" marker on a local project. */
  setUploaded(id: string, uploadedTo: NonNullable<Project['uploadedTo']>): Project {
    const p = this.require(id);
    p.uploadedTo = uploadedTo;
    this.save(p);
    return structuredClone(p);
  }

  list(): Project[] {
    return [...this.projects.values()].map((p) => structuredClone(p));
  }

  get(id: string): Project | undefined {
    const p = this.projects.get(id);
    return p && structuredClone(p);
  }

  require(id: string): Project {
    const p = this.projects.get(id);
    if (!p) throw new InputError('project not found');
    return p;
  }

  create(input: { name?: unknown; description?: unknown }): Project {
    const now = this.now().toISOString();
    let id = newId();
    while (this.projects.has(id) || existsSync(join(this.root, id))) id = newId();
    const p: Project = {
      id,
      name: cleanName(input.name, 'project'),
      description: str(input.description, 2000),
      browser: { engine: 'chromium', headless: true },
      pinned: false,
      createdAt: now,
      lastOpenedAt: now,
      environments: [],
      suites: [],
    };
    const dir = this.dir(id);
    for (const d of PROJECT_SUBDIRS) mkdirSync(join(dir, d), { recursive: true });
    this.projects.set(id, p);
    this.save(p);
    return structuredClone(p);
  }

  /** Basic info / browser defaults / default env / pinned. Returns changed keys. */
  update(id: string, patch: Record<string, unknown>): { project: Project; changed: string[] } {
    const p = this.require(id);
    const changed: string[] = [];
    if (patch.name !== undefined) {
      const n = cleanName(patch.name, 'project');
      if (n !== p.name) (p.name = n), changed.push('name');
    }
    if (patch.description !== undefined) {
      const d = str(patch.description, 2000);
      if (d !== p.description) (p.description = d), changed.push('description');
    }
    if (patch.pinned !== undefined && typeof patch.pinned === 'boolean' && patch.pinned !== p.pinned) (p.pinned = patch.pinned), changed.push('pinned');
    if (patch.browser !== undefined) {
      const b = cleanBrowser(patch.browser, p.browser);
      if (JSON.stringify(b) !== JSON.stringify(p.browser)) (p.browser = b), changed.push('browser');
    }
    if (patch.defaultEnvId !== undefined) {
      if (patch.defaultEnvId === '' || patch.defaultEnvId === null) {
        if (p.defaultEnvId) delete p.defaultEnvId, changed.push('defaultEnvId');
      } else {
        if (!p.environments.some((e) => e.id === patch.defaultEnvId)) throw new InputError('environment not found');
        if (p.defaultEnvId !== patch.defaultEnvId) (p.defaultEnvId = patch.defaultEnvId as string), changed.push('defaultEnvId');
      }
    }
    if (changed.length) this.save(p);
    return { project: structuredClone(p), changed };
  }

  touch(id: string): void {
    const p = this.require(id);
    p.lastOpenedAt = this.now().toISOString();
    this.save(p);
  }

  env(id: string, envId: string): Environment {
    const e = this.require(id).environments.find((x) => x.id === envId);
    if (!e) throw new InputError('environment not found');
    return e;
  }

  upsertEnv(id: string, envId: string | undefined, input: EnvInput): { env: Environment; created: boolean } {
    const p = this.require(id);
    const existing = envId ? p.environments.find((e) => e.id === envId) : undefined;
    if (envId && !existing) throw new InputError('environment not found');
    const name = input.name !== undefined ? cleanName(input.name, 'environment') : existing?.name;
    if (!name) throw new InputError('environment name is required');
    if (p.environments.some((e) => e.id !== envId && e.name === name)) throw new InputError(`an environment named "${name}" already exists`);
    let secretsFile = existing?.secretsFile;
    if (input.secretsFile !== undefined) {
      const f = str(input.secretsFile, 2000);
      if (f && !isAbsolute(f)) throw new InputError('secrets file path must be absolute');
      secretsFile = f || undefined;
    }
    let allowedDomains = existing?.allowedDomains;
    if (input.allowedDomains !== undefined) allowedDomains = input.allowedDomains === null ? undefined : cleanDomains(input.allowedDomains);
    const env: Environment = {
      id: existing?.id ?? newId(),
      name,
      baseUrl: input.baseUrl !== undefined ? cleanBaseUrl(input.baseUrl) : (existing?.baseUrl ?? ''),
      vars: input.vars !== undefined ? cleanVars(input.vars) : { ...(existing?.vars ?? {}) },
      secretNames: [...(existing?.secretNames ?? [])],
      ...(secretsFile ? { secretsFile } : {}),
      ...(allowedDomains ? { allowedDomains } : {}),
    };
    if (existing) p.environments[p.environments.indexOf(existing)] = env;
    else p.environments.push(env);
    if (!p.defaultEnvId) p.defaultEnvId = env.id;
    this.save(p);
    return { env: structuredClone(env), created: !existing };
  }

  deleteEnv(id: string, envId: string): Environment {
    const p = this.require(id);
    const e = this.env(id, envId);
    p.environments = p.environments.filter((x) => x.id !== envId);
    if (p.defaultEnvId === envId) {
      if (p.environments[0]) p.defaultEnvId = p.environments[0].id;
      else delete p.defaultEnvId;
    }
    for (const s of p.suites) if (s.envId === envId) delete s.envId;
    this.save(p);
    return structuredClone(e);
  }

  /** Keep the stored secret names in sync with the vault (names only). */
  setSecretNames(id: string, envId: string, names: string[]): void {
    const p = this.require(id);
    const e = this.env(id, envId);
    e.secretNames = [...new Set(names)].sort();
    this.save(p);
  }

  upsertSuite(id: string, suiteId: string | undefined, input: SuiteInput): Suite {
    const p = this.require(id);
    const existing = suiteId ? p.suites.find((s) => s.id === suiteId) : undefined;
    if (suiteId && !existing) throw new InputError('suite not found');
    const scripts = input.scripts !== undefined ? (Array.isArray(input.scripts) ? input.scripts.slice(0, 200).map(cleanScriptPath) : []) : [...(existing?.scripts ?? [])];
    let envId = existing?.envId;
    if (input.envId !== undefined) {
      if (input.envId === '' || input.envId === null) envId = undefined;
      else if (p.environments.some((e) => e.id === input.envId)) envId = input.envId as string;
      else throw new InputError('environment not found');
    }
    const s: Suite = {
      id: existing?.id ?? newId(),
      name: input.name !== undefined ? cleanName(input.name, 'suite') : (existing?.name ?? ''),
      scripts,
      ...(envId ? { envId } : {}),
      stopOnFailure: typeof input.stopOnFailure === 'boolean' ? input.stopOnFailure : (existing?.stopOnFailure ?? false),
    };
    const always = alwaysRunOf(input.alwaysRun !== undefined ? input.alwaysRun : existing?.alwaysRun, scripts);
    if (always.length) s.alwaysRun = always;
    if (!s.name) throw new InputError('suite name is required');
    if (existing) p.suites[p.suites.indexOf(existing)] = s;
    else p.suites.push(s);
    this.save(p);
    return structuredClone(s);
  }

  deleteSuite(id: string, suiteId: string): void {
    const p = this.require(id);
    p.suites = p.suites.filter((s) => s.id !== suiteId);
    this.save(p);
  }

  /** Keep suites pointing at a renamed/deleted script. */
  renameScriptRefs(id: string, from: string, to: string | undefined): void {
    const p = this.require(id);
    let touched = false;
    for (const s of p.suites) {
      const next = s.scripts.flatMap((x) => (x === from ? (to ? [to] : []) : [x]));
      if (next.join('\n') !== s.scripts.join('\n')) (s.scripts = next), (touched = true);
      if (s.alwaysRun?.includes(from)) {
        const always = alwaysRunOf(s.alwaysRun.flatMap((x) => (x === from ? (to ? [to] : []) : [x])), s.scripts);
        if (always.length) s.alwaysRun = always;
        else delete s.alwaysRun;
        touched = true;
      }
    }
    if (touched) this.save(p);
  }

  /** Carry this PC's list position data onto another project (올리기 = 전환 · 합치기). */
  setMeta(id: string, meta: { pinned?: boolean; createdAt?: string; lastOpenedAt?: string }): void {
    const p = this.require(id);
    if (typeof meta.pinned === 'boolean') p.pinned = meta.pinned;
    if (meta.createdAt) p.createdAt = meta.createdAt;
    if (meta.lastOpenedAt) p.lastOpenedAt = meta.lastOpenedAt;
    this.save(p);
  }

  /** Delete the project folder (the caller removes vault entries). */
  delete(id: string): Project {
    const p = this.require(id);
    const dir = this.dir(id);
    this.projects.delete(id);
    this.cloudDirs.delete(id);
    rmSync(dir, { recursive: true, force: true });
    return structuredClone(p);
  }

  private save(p: Project): void {
    writeJsonAtomic(join(this.dir(p.id), 'project.json'), p);
  }
}

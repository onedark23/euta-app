// Run-option assembly for a project environment (SPEC "실행과 환경"). Pure functions:
//   env      = process env + BASE_URL (environment baseUrl) + environment vars (+ per-run overrides)
//   secrets  = vault values of the environment, or its external secrets file
//   runsDir  = <project>/runs, baselineDir = <project>/baselines/<envId>
//   browser  = project defaults (per-run overrides win)
// The DSL is unchanged: scripts keep `target.baseUrl: ${env.BASE_URL}`.
import { join } from 'node:path';
import type { ServerConfig } from '@euta/mcp-server/tools';
import type { BrowserEngine, Environment, Project } from '../../shared/types.js';

/** Env keys never visible to scripts (${env.*}) — app-internal credentials. */
export const INTERNAL_ENV = new Set(['EUTA_APP_EVENTS_TOKEN', 'EUTA_APP_TOKEN']);

export interface ProjectRunContext {
  project: Project;
  /** Absolute project folder (<userData>/projects/<id>). */
  projectDir: string;
  env?: Environment;
  /** Resolved secret values (main process only). */
  secrets: Record<string, string>;
  /** Hosts where secret fill/type steps may run (SPEC 프로젝트-관리 "secrets 규칙"). Missing = [] (nowhere). */
  allowedDomains?: string[];
  processEnv?: NodeJS.ProcessEnv;
}

export interface RunOverrides {
  vars?: Record<string, string>;
  env?: Record<string, string>;
  headless?: boolean;
  browser?: BrowserEngine;
}

export interface AssembledRun {
  env: Record<string, string | undefined>;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  runsDir: string;
  baselineDir?: string;
  headless: boolean;
  browserEngine: BrowserEngine;
  browserDevice?: string;
  meta: Record<string, string>;
  /** Secret rules for every local run: placement restriction + allowed domains (no cloud-only rules). */
  restrictSecrets: true;
  allowedDomains: string[];
}

export function projectDirs(projectDir: string, envId?: string): { scripts: string; runs: string; baselines?: string; suiteRuns: string; chats: string; recordings: string } {
  return {
    recordings: join(projectDir, 'recordings'),
    scripts: join(projectDir, 'scripts'),
    runs: join(projectDir, 'runs'),
    ...(envId ? { baselines: join(projectDir, 'baselines', envId) } : {}),
    suiteRuns: join(projectDir, 'suite-runs'),
    chats: join(projectDir, 'chats'),
  };
}

export function scriptEnv(c: ProjectRunContext, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(c.processEnv ?? process.env)) if (!INTERNAL_ENV.has(k)) out[k] = v;
  if (c.env?.baseUrl) out.BASE_URL = c.env.baseUrl;
  Object.assign(out, c.env?.vars ?? {}, extra);
  return out;
}

export function runMeta(c: ProjectRunContext, extra: Record<string, string> = {}): Record<string, string> {
  return {
    projectId: c.project.id,
    projectName: c.project.name,
    ...(c.env ? { envId: c.env.id, envName: c.env.name } : {}),
    ...extra,
  };
}

export function assembleRun(c: ProjectRunContext, o: RunOverrides = {}, metaExtra: Record<string, string> = {}): AssembledRun {
  const dirs = projectDirs(c.projectDir, c.env?.id);
  return {
    env: scriptEnv(c, o.env),
    vars: { ...(o.vars ?? {}) },
    secrets: { ...c.secrets },
    runsDir: dirs.runs,
    ...(dirs.baselines ? { baselineDir: dirs.baselines } : {}),
    headless: o.headless ?? c.project.browser.headless,
    browserEngine: o.browser ?? c.project.browser.engine,
    ...(c.project.browser.device ? { browserDevice: c.project.browser.device } : {}),
    meta: runMeta(c, metaExtra),
    restrictSecrets: true,
    allowedDomains: [...(c.allowedDomains ?? [])],
  };
}

/** Engine tool-handler config for the in-app AI chat in this environment. */
export function aiServerConfig(c: ProjectRunContext): ServerConfig {
  const a = assembleRun(c);
  return {
    runsDir: a.runsDir,
    ...(a.baselineDir ? { baselineDir: a.baselineDir } : {}),
    secrets: a.secrets,
    env: a.env,
    runHeadless: a.headless,
    // Sessions opened by the AI are headed by default so the user can watch.
    sessionHeadless: false,
    stepImage: 'on-failure',
    runBrowser: { engine: a.browserEngine, ...(a.browserDevice ? { device: a.browserDevice } : {}) },
    runMeta: { ...a.meta, source: 'ai' },
    // Same secret rules as the run button (SPEC 프로젝트-관리 "secrets 규칙").
    restrictSecrets: true,
    allowedDomains: a.allowedDomains,
  };
}

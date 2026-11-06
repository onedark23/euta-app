// euta tools for the in-app AI chat: the engine's transport-neutral handlers
// (same vocabulary/semantics as the MCP server, ADR-008) + working-folder file tools.
// Runs and sessions they start feed the LiveStore directly (source 'ai'). The handler
// config (runs dir, baselines, env, secrets, browser defaults, run meta) comes from the
// chat's project environment (ADR-016).
import { resolve } from 'node:path';
import { createEutaToolHandlers, type EutaTool, type EutaTools, type ServerConfig } from '@euta/mcp-server/tools';
import type { LiveStore } from '../live-store.js';
import { createRecordingTools, type RecordingAccess } from './recording-tools.js';
import { createTcTools } from './tc-tools.js';
import type { TcDocAccess } from '../project/tc-docs.js';
import { createWorkspaceTools } from './workspace-tools.js';

export interface AppTools {
  tools: EutaTool[];
  byName: Map<string, EutaTool>;
  names: ReadonlySet<string>;
  handlers: EutaTools;
  workDir: string;
  secretNames: string[];
  config: ServerConfig;
  /** Close sessions opened by the AI. */
  shutdown(): Promise<void>;
}

export interface AppToolsOptions {
  config: ServerConfig;
  workDir: string;
  live?: LiveStore;
  /** Project the runs belong to (Live tagging). */
  projectId?: string;
  /** External secrets file of the environment: never readable through read_file. */
  secretsFile?: string;
  /** Every run/session the AI starts (activity log). */
  onRunStarted?: (runId: string) => void;
  /** The project's demonstration recordings (get_recording). */
  recordings?: RecordingAccess;
  /** History-aware script writes for save_script (ADR-018). */
  writeScript?: (absPath: string, content: string) => void | Promise<void>;
  /** read_file of a file in the working folder (cloud: remembers the version the AI read). */
  onRead?: (absPath: string, text: string) => void;
  /** The project's TC documents (get_tc_doc · get_tc · set_tc_conversion · get_tc_import · save_tc_extraction). */
  tcDocs?: TcDocAccess;
}

export function createAppTools(o: AppToolsOptions): AppTools {
  const workDir = resolve(o.workDir);
  const config = o.config;
  const live = o.live;
  const handlers = createEutaToolHandlers(config, {
    workDir,
    writeRoot: workDir,
    sessionName: 'ai session',
    onRunStarted: (bus, info) => {
      try {
        o.onRunStarted?.(info.runId);
      } catch {
        /* activity hooks never break a run */
      }
      if (!live) return;
      live.registerAppRun(info.runId, info.runDir, 'ai', o.projectId);
      bus.onAny((e) => live.ingest([e], 'ai'), { replay: true });
    },
  });
  const tools = [
    ...handlers.tools,
    ...createWorkspaceTools(handlers, {
      workDir,
      ...(o.secretsFile ? { secretsFile: o.secretsFile } : {}),
      inputs: () => ({ env: config.env, secrets: config.secrets }),
      ...(o.writeScript ? { writeScript: o.writeScript } : {}),
      ...(o.onRead ? { onRead: o.onRead } : {}),
    }),
    ...(o.recordings ? createRecordingTools(handlers, o.recordings) : []),
    ...(o.tcDocs ? createTcTools(handlers, o.tcDocs) : []),
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    tools,
    byName,
    names: new Set(byName.keys()),
    handlers,
    workDir,
    secretNames: Object.keys(config.secrets),
    config,
    shutdown: () => handlers.shutdown(),
  };
}

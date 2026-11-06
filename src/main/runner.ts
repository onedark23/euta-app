// Helpers for in-app runs via @euta/core (Playwright runs in this main process). Run
// assembly per project environment lives in project/run-options.ts + project/service.ts.
import { OsInputUnavailableError, loadSecretsFile, type InputDriverFactory } from '@euta/core';

/** Parse `KEY=VALUE` lines (blank lines and `#` comments ignored). */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) out[key] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Load secrets from the configured file. Values never leave the main process; errors
 * are reported generically (parser messages can quote file content).
 */
export function loadSecrets(file: string): { secrets: Record<string, string>; error?: string } {
  if (!file) return { secrets: {} };
  try {
    return { secrets: loadSecretsFile(file) };
  } catch {
    return { secrets: {}, error: 'secrets file could not be read or parsed' };
  }
}

/**
 * `inputDrivers` option that loads the optional @euta/input-os adapter only when a
 * step actually uses `input: os` (ADR-013, same policy as the engine CLI/MCP server).
 * EUTA_OS_INPUT=0 disables it.
 */
export function osInputOption(env: NodeJS.ProcessEnv = process.env): { inputDrivers?: { os: InputDriverFactory } } {
  if (env.EUTA_OS_INPUT === '0') return {};
  const os: InputDriverFactory = async (ctx) => {
    let mod: { osInputDriverFactory: InputDriverFactory };
    try {
      mod = await import('@euta/input-os');
    } catch {
      throw new OsInputUnavailableError();
    }
    return mod.osInputDriverFactory(ctx);
  };
  return { inputDrivers: { os } };
}

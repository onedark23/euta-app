// Small file helpers for project storage (SPEC 프로젝트-관리 "쓰기 규칙").
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

let tmpSeq = 0;

/** Write JSON atomically: unique temp file in the same folder, then rename over the target. */
export function writeJsonAtomic(file: string, value: unknown, pretty = true): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    writeFileSync(tmp, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Replace a text file atomically: hidden temp file in the same folder (ignored by the script watcher), then rename. */
export function writeTextAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${++tmpSeq}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Parsed JSON, or undefined when missing/unreadable. */
export function readJson<T = unknown>(file: string): T | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random id (lowercase alphanumeric). Independent of names. */
export function newId(len = 10): string {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export const ID_RE = /^[a-z0-9]{6,32}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

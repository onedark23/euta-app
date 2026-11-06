// Read run artifacts for display. Only image files that resolve (after symlinks)
// inside the run dir are served, as data URLs.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Absolute path of `rel` inside `runDir`, or undefined if it escapes or is not an allowed image. */
export function resolveArtifact(runDir: string, rel: string): string | undefined {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0')) return undefined;
  if (!IMAGE_TYPES[extname(rel).toLowerCase()]) return undefined;
  let root: string;
  let file: string;
  try {
    root = realpathSync(runDir);
    file = realpathSync(resolve(root, rel));
  } catch {
    return undefined;
  }
  if (!file.startsWith(root + sep)) return undefined;
  if (!IMAGE_TYPES[extname(file).toLowerCase()]) return undefined;
  return file;
}

export function readArtifactImage(runDir: string, rel: string): string | undefined {
  const file = resolveArtifact(runDir, rel);
  if (!file) return undefined;
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return undefined;
  const mime = IMAGE_TYPES[extname(file).toLowerCase()]!;
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

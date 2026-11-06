import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArtifactImage, resolveArtifact } from '../../src/main/artifacts.js';
import { loadSecrets, osInputOption, parseKeyValues } from '../../src/main/runner.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'euta-misc-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('artifact reader', () => {
  it('serves only images inside the run dir (no traversal, no symlink escape, no other types)', () => {
    const root = tmp();
    const run = join(root, 'run');
    mkdirSync(join(run, 'screenshots'), { recursive: true });
    writeFileSync(join(run, 'screenshots/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(run, 'steps.jsonl'), '{}');
    writeFileSync(join(root, 'outside.png'), 'x');
    symlinkSync(join(root, 'outside.png'), join(run, 'screenshots/link.png'));
    expect(resolveArtifact(run, 'screenshots/a.png')).toBeTruthy();
    expect(readArtifactImage(run, 'screenshots/a.png')).toMatch(/^data:image\/png;base64,/);
    expect(resolveArtifact(run, '../outside.png')).toBeUndefined();
    expect(resolveArtifact(run, join(root, 'outside.png'))).toBeUndefined();
    expect(resolveArtifact(run, 'screenshots/link.png')).toBeUndefined();
    expect(resolveArtifact(run, 'steps.jsonl')).toBeUndefined();
    expect(resolveArtifact(run, 'screenshots/missing.png')).toBeUndefined();
  });
});

describe('runner helpers', () => {
  it('parses KEY=VALUE lines', () => {
    expect(parseKeyValues('# c\nA=1\n  B = two words \nbad line\n=x\nC=a=b\n')).toEqual({ A: '1', B: 'two words', C: 'a=b' });
  });

  it('never surfaces secrets-file content in errors', () => {
    const d = tmp();
    const f = join(d, 's.json');
    writeFileSync(f, '{"PASSWORD": "hunter2-secret-value",');
    const r = loadSecrets(f);
    expect(r.secrets).toEqual({});
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('hunter2');
    writeFileSync(f, '{"PASSWORD": "hunter2"}');
    expect(loadSecrets(f).secrets).toEqual({ PASSWORD: 'hunter2' });
  });
});

describe('OS input adapter option (ADR-013)', () => {
  it('provides a lazy os driver factory by default and none when EUTA_OS_INPUT=0', () => {
    expect(typeof osInputOption({}).inputDrivers?.os).toBe('function');
    expect(osInputOption({ EUTA_OS_INPUT: '0' })).toEqual({});
  });

  it('resolves the optional adapter package', async () => {
    const mod = (await import('@euta/input-os')) as { osInputDriverFactory?: unknown };
    expect(typeof mod.osInputDriverFactory).toBe('function');
  });
});

// Shared test helpers (not a test file).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SafeStorageLike } from '../../src/main/project/vault.js';

/** Reversible stand-in for Electron safeStorage (XOR + header) — never stores the plaintext. */
export function mockSafeStorage(o: { available?: boolean; backend?: string } = {}): SafeStorageLike & { calls: number } {
  const x = (b: Buffer): Buffer => Buffer.from(b.map((c, i) => c ^ (0x5a + (i % 7))));
  const m = {
    calls: 0,
    isEncryptionAvailable: () => o.available ?? true,
    encryptString(plain: string): Buffer {
      m.calls++;
      return Buffer.concat([Buffer.from('v10'), x(Buffer.from(plain, 'utf8'))]);
    },
    decryptString(cipher: Buffer): string {
      if (cipher.subarray(0, 3).toString() !== 'v10') throw new Error('bad ciphertext');
      return x(cipher.subarray(3)).toString('utf8');
    },
    ...(o.backend ? { getSelectedStorageBackend: () => o.backend! } : {}),
  };
  return m;
}

/** Every file under `root` (recursive). */
export function allFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}


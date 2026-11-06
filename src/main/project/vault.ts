// Secret vault: <userData>/vault.json holds ciphertext only (Electron safeStorage, main
// process). Key = projectId/envId/NAME. Values are never returned to the renderer, the AI,
// logs or reports — only `resolve()` (main-only, run assembly) decrypts.
import { join } from 'node:path';
import type { VaultStatus } from '../../shared/types.js';
import { isId, readJson, writeJsonAtomic } from './fsx.js';

/** The subset of Electron's safeStorage the vault uses (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  /** Linux only. */
  getSelectedStorageBackend?(): string;
}

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;

export class VaultUnavailableError extends Error {
  constructor(reason: string) {
    super(`secrets cannot be stored: ${reason}`);
    this.name = 'VaultUnavailableError';
  }
}

interface VaultFile {
  schema: 1;
  /** key → base64 ciphertext */
  entries: Record<string, string>;
}

const key = (projectId: string, envId: string, name: string): string => `${projectId}/${envId}/${name}`;

export class Vault {
  readonly file: string;
  private data: VaultFile;

  constructor(
    userData: string,
    private readonly storage: SafeStorageLike,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.file = join(userData, 'vault.json');
    const raw = readJson<VaultFile>(this.file);
    const entries: Record<string, string> = {};
    if (raw && typeof raw.entries === 'object' && raw.entries) {
      for (const [k, v] of Object.entries(raw.entries)) if (typeof v === 'string' && /^[a-z0-9]+\/[a-z0-9]+\/[A-Za-z_][A-Za-z0-9_]*$/.test(k)) entries[k] = v;
    }
    this.data = { schema: 1, entries };
  }

  status(): VaultStatus {
    let available = false;
    try {
      available = this.storage.isEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) return { available: false, reason: 'OS 보안 저장소(키체인 등)를 사용할 수 없습니다. 외부 secrets 파일을 지정하세요.' };
    if (this.platform === 'linux' && typeof this.storage.getSelectedStorageBackend === 'function') {
      const backend = this.storage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') {
        return { available: false, backend, reason: `비밀값 저장소가 평문 수준(${backend})입니다. gnome-keyring/kwallet 을 설정하거나 외부 secrets 파일을 지정하세요.` };
      }
      return { available: true, backend };
    }
    return { available: true };
  }

  /** Encrypt and store. Throws VaultUnavailableError when encryption is not OS-backed. */
  set(projectId: string, envId: string, name: string, value: string): void {
    if (!isId(projectId) || !isId(envId)) throw new Error('invalid project/environment id');
    if (!SECRET_NAME_RE.test(name)) throw new Error('secret name must match [A-Za-z_][A-Za-z0-9_]*');
    if (typeof value !== 'string' || value.length === 0) throw new Error('secret value is empty');
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error('secret value is too large');
    const st = this.status();
    if (!st.available) throw new VaultUnavailableError(st.reason ?? 'encryption unavailable');
    this.data.entries[key(projectId, envId, name)] = this.storage.encryptString(value).toString('base64');
    this.save();
  }

  remove(projectId: string, envId: string, name: string): boolean {
    const k = key(projectId, envId, name);
    if (!(k in this.data.entries)) return false;
    delete this.data.entries[k];
    this.save();
    return true;
  }

  names(projectId: string, envId: string): string[] {
    const prefix = `${projectId}/${envId}/`;
    return Object.keys(this.data.entries)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  /**
   * Decrypted values for one environment — main process only (run assembly). Entries
   * that cannot be decrypted (e.g. keychain reset) are skipped and reported by name.
   */
  resolve(projectId: string, envId: string): { secrets: Record<string, string>; failed: string[] } {
    const secrets: Record<string, string> = {};
    const failed: string[] = [];
    for (const name of this.names(projectId, envId)) {
      try {
        secrets[name] = this.storage.decryptString(Buffer.from(this.data.entries[key(projectId, envId, name)]!, 'base64'));
      } catch {
        failed.push(name);
      }
    }
    return { secrets, failed };
  }

  /**
   * Move one environment's entries to another project / environment key without decrypting
   * (올리기 = 전환 · 합치기). Existing target entries are kept unless `overwrite`.
   */
  moveEnv(fromProject: string, fromEnv: string, toProject: string, toEnv: string, overwrite = true): number {
    if (!isId(toProject) || !isId(toEnv)) throw new Error('invalid project/environment id');
    const prefix = `${fromProject}/${fromEnv}/`;
    let n = 0;
    for (const k of Object.keys(this.data.entries).filter((x) => x.startsWith(prefix))) {
      const to = key(toProject, toEnv, k.slice(prefix.length));
      if (overwrite || !(to in this.data.entries)) this.data.entries[to] = this.data.entries[k]!;
      delete this.data.entries[k];
      n++;
    }
    if (n) this.save();
    return n;
  }

  /** Remove every entry under projectId/ or projectId/envId/. */
  removePrefix(projectId: string, envId?: string): number {
    const prefix = envId ? `${projectId}/${envId}/` : `${projectId}/`;
    const keys = Object.keys(this.data.entries).filter((k) => k.startsWith(prefix));
    for (const k of keys) delete this.data.entries[k];
    if (keys.length) this.save();
    return keys.length;
  }

  private save(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

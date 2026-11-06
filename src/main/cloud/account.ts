// Cloud connection settings: <userData>/cloud/account.json = server address, signed-in account
// (id · email · name) and the device token as safeStorage ciphertext (same as the vault —
// SPEC 클라우드 연결 "토큰 보관"). The token is decrypted only in the main process.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../project/fsx.js';
import { VaultUnavailableError, type SafeStorageLike } from '../project/vault.js';

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  isAdmin?: boolean;
}

interface AccountFile {
  schema: 1;
  serverUrl: string;
  user?: CloudUser;
  /** base64 safeStorage ciphertext of the device access token. */
  token?: string;
}

/** Short stable id of a server address (working copies live under cloud/<serverId>/). */
export const serverIdOf = (url: string): string => createHash('sha256').update(url).digest('hex').slice(0, 12);

export class CloudAccount {
  readonly file: string;
  private data: AccountFile;
  private cached: string | undefined;

  constructor(
    readonly userData: string,
    private readonly storage: SafeStorageLike,
  ) {
    this.file = join(userData, 'cloud', 'account.json');
    const raw = readJson<Partial<AccountFile>>(this.file);
    this.data = {
      schema: 1,
      serverUrl: typeof raw?.serverUrl === 'string' ? raw.serverUrl : '',
      ...(raw?.user && typeof raw.user.id === 'string' ? { user: raw.user } : {}),
      ...(typeof raw?.token === 'string' && raw.token ? { token: raw.token } : {}),
    };
  }

  get serverUrl(): string {
    return this.data.serverUrl;
  }

  get serverId(): string {
    return this.data.serverUrl ? serverIdOf(this.data.serverUrl) : '';
  }

  get user(): CloudUser | undefined {
    return this.data.user;
  }

  hasToken(): boolean {
    return !!this.data.token;
  }

  /** Changing the server signs out (the token belongs to the old server). */
  setServer(url: string): void {
    if (url === this.data.serverUrl) return;
    this.data = { schema: 1, serverUrl: url };
    this.cached = undefined;
    this.save();
  }

  /** Decrypted token (main process only), or undefined. */
  token(): string | undefined {
    if (this.cached) return this.cached;
    if (!this.data.token) return undefined;
    try {
      this.cached = this.storage.decryptString(Buffer.from(this.data.token, 'base64'));
      return this.cached;
    } catch {
      return undefined;
    }
  }

  setToken(token: string, user: CloudUser): void {
    let ok = false;
    try {
      ok = this.storage.isEncryptionAvailable();
    } catch {
      ok = false;
    }
    if (!ok) throw new VaultUnavailableError('OS 보안 저장소를 사용할 수 없어 로그인 정보를 저장할 수 없습니다');
    this.data.token = this.storage.encryptString(token).toString('base64');
    this.data.user = user;
    this.cached = token;
    this.save();
  }

  setUser(user: CloudUser): void {
    this.data.user = user;
    this.save();
  }

  clearToken(): void {
    delete this.data.token;
    delete this.data.user;
    this.cached = undefined;
    this.save();
  }

  private save(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

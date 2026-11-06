// App-global state: <userData>/app.json — recent project order, last project, AI default model,
// cloud notifications, screen theme. (The old global settings.json is not read: SPEC "기존 전역 데이터 이관 없음".)
import { join } from 'node:path';
import type { AppSettings, AppTheme } from '../../shared/types.js';
import { isId, readJson, writeJsonAtomic } from './fsx.js';

export interface AppStateData {
  schema: 1;
  /** Project ids, most recently opened first. */
  recent: string[];
  lastProjectId?: string;
  aiModel: string;
  /** OS notifications for euta cloud events (default on). */
  cloudNotify: boolean;
  /** Screen theme (default: follow the OS). */
  theme: AppTheme;
}

const MODEL_RE = /^[A-Za-z0-9._[\]:-]{0,80}$/;
const THEMES: readonly AppTheme[] = ['system', 'light', 'dark'];
export const isTheme = (v: unknown): v is AppTheme => THEMES.includes(v as AppTheme);

/** Apply the screen theme: Electron then reports it to the renderer as prefers-color-scheme. */
export function applyTheme(nativeTheme: { themeSource: AppTheme }, theme: AppTheme): void {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
}

export function sanitizeAppState(raw: unknown): AppStateData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const recent = Array.isArray(r.recent) ? [...new Set(r.recent.filter(isId))].slice(0, 200) : [];
  return {
    schema: 1,
    recent,
    ...(isId(r.lastProjectId) ? { lastProjectId: r.lastProjectId } : {}),
    aiModel: typeof r.aiModel === 'string' && MODEL_RE.test(r.aiModel) ? r.aiModel : '',
    cloudNotify: r.cloudNotify !== false,
    theme: isTheme(r.theme) ? r.theme : 'system',
  };
}

export class AppStateStore {
  private data: AppStateData;
  readonly file: string;

  constructor(userData: string) {
    this.file = join(userData, 'app.json');
    this.data = sanitizeAppState(readJson(this.file));
  }

  get(): AppStateData {
    return { ...this.data, recent: [...this.data.recent] };
  }

  settings(): AppSettings {
    return { aiModel: this.data.aiModel, cloudNotify: this.data.cloudNotify, theme: this.data.theme };
  }

  /** Returns the changed keys. */
  updateSettings(patch: unknown): { settings: AppSettings; changed: string[] } {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const changed: string[] = [];
    if (typeof p.aiModel === 'string' && MODEL_RE.test(p.aiModel) && p.aiModel !== this.data.aiModel) {
      this.data.aiModel = p.aiModel;
      changed.push('aiModel');
    }
    if (typeof p.cloudNotify === 'boolean' && p.cloudNotify !== this.data.cloudNotify) {
      this.data.cloudNotify = p.cloudNotify;
      changed.push('cloudNotify');
    }
    if (isTheme(p.theme) && p.theme !== this.data.theme) {
      this.data.theme = p.theme;
      changed.push('theme');
    }
    if (changed.length) this.save();
    return { settings: this.settings(), changed };
  }

  touchProject(id: string): void {
    this.data.recent = [id, ...this.data.recent.filter((x) => x !== id)];
    this.data.lastProjectId = id;
    this.save();
  }

  /** `from` became `to` (올리기 = 전환 · 합치기): `to` takes `from`'s place in the recent order. */
  replaceProject(from: string, to: string): void {
    const i = this.data.recent.indexOf(from);
    const rest = this.data.recent.filter((x) => x !== to);
    const at = rest.indexOf(from);
    if (i >= 0 && at >= 0) rest.splice(at, 1, to);
    else if (!rest.includes(to)) rest.unshift(to);
    this.data.recent = rest.filter((x) => x !== from);
    if (this.data.lastProjectId === from) this.data.lastProjectId = to;
    this.save();
  }

  forgetProject(id: string): void {
    this.data.recent = this.data.recent.filter((x) => x !== id);
    if (this.data.lastProjectId === id) delete this.data.lastProjectId;
    this.save();
  }

  private save(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

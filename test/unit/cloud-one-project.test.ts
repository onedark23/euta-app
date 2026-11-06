// Stage 15 "한 프로젝트 + 권한" against the in-memory fake cloud (e2e/fake-cloud.ts, real HTTP):
// 올리기 = 전환 (one entry, this PC's runs / vault values moved, index paths rewritten, resumable),
// role by `can` (runner = 실행 전용), access lost (404 / `access_lost`) → lock → re-invite unlocks,
// receive list, access request, merge with a fixed target (identical · choices · ORIGIN_MISMATCH).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunIndex } from '@euta/core';
import { CloudService } from '../../src/main/cloud/cloud-service.js';
import { compactId, WorkingCopy } from '../../src/main/cloud/workcopy.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { FakeCloud } from '../../e2e/fake-cloud.js';
import { mockSafeStorage } from './helpers.js';

const A = 'owner@example.com';
const B = 'member@example.com';
const SCRIPT = (name: string, path = '/') => `version: 1\nname: ${name}\ntarget:\n  baseUrl: \${env.BASE_URL}\nsteps:\n  - goto: ${path}\n`;
const PC_VALUE = 'this-pc-only-value-4471';

const until = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface Pc {
  userData: string;
  svc: ProjectService;
  cloud: CloudService;
}

/** One local run recorded the way the engine does (index.sqlite with absolute dir / script path). */
function fakeRun(svc: ProjectService, projectId: string, runId: string): void {
  const root = svc.store.dir(projectId);
  const dir = join(root, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id: runId, meta: { envName: 'dev' } }));
  RunIndex.with(join(root, 'runs'), (idx) => {
    idx.upsertRun({ id: runId, kind: 'script', name: 'login', scriptPath: join(root, 'scripts', 'login.yaml'), status: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 10, dir, browser: 'chromium', total: 1, passed: 0, failed: 1, errors: 0, skipped: 0 });
    idx.replaceSteps(runId, [{ runId, stepId: 's1', idx: 0, action: 'goto', name: null, status: 'failed', durationMs: 10, error: 'x' }]);
  });
}

describe('one project + permissions (fake cloud)', () => {
  const fake = new FakeCloud();
  const ss = mockSafeStorage();
  let root: string;
  const pcs: Pc[] = [];

  const makePc = async (name: string, email: string): Promise<Pc> => {
    const userData = join(root, name);
    const live = new LiveStore({ throttleMs: 0 });
    const svc = new ProjectService({ userData, safeStorage: ss, live, watch: false, platform: 'darwin' });
    const cloud = new CloudService({ userData, safeStorage: ss, projects: svc, retry: { min: 50, max: 100 } });
    cloud.setServer(fake.url);
    const st = await cloud.login();
    fake.approveDevice(st.login!.userCode, email);
    await until(() => cloud.status().state === 'online');
    const pc = { userData, svc, cloud };
    pcs.push(pc);
    return pc;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'euta-one-project-'));
    fake.addUser(A, '소유자A');
    fake.addUser(B, '구성원B');
    await fake.start();
  });
  afterAll(async () => {
    for (const p of pcs) p.cloud.dispose();
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });

  let a: Pc;
  let b: Pc;
  let localId = '';
  let cloudAppId = '';

  it('올리기 = 전환: one sidebar entry, this PC runs + vault values moved, run index paths rewritten', async () => {
    a = await makePc('A', A);
    const v = a.svc.create({ name: '고객 포털', baseUrl: 'https://portal.example.com' });
    localId = v.id;
    const envId = v.environments[0]!.id;
    a.svc.writeScript(localId, 'login.yaml', SCRIPT('로그인', '/login'), 'user');
    a.svc.setSecret(localId, envId, 'USER_PASSWORD', PC_VALUE);
    a.svc.upsertSuite(localId, undefined, { name: '회귀', scripts: ['login.yaml'], stopOnFailure: true });
    fakeRun(a.svc, localId, 'run-local-1');
    mkdirSync(join(a.svc.store.dir(localId), 'baselines', envId), { recursive: true });
    writeFileSync(join(a.svc.store.dir(localId), 'baselines', envId, 'b.png'), 'png');
    a.svc.open(localId);

    const pre = a.cloud.convertPreview(localId);
    expect(pre).toMatchObject({ scripts: 1, environments: ['default'], suites: 1, credentialNames: ['USER_PASSWORD'], runs: 1 });
    const r = await a.cloud.upload(localId);
    cloudAppId = r.localId;
    const p = fake.byName('고객 포털');
    expect(cloudAppId).toBe(compactId(p.id));
    expect(p).toMatchObject({ origin: 'app', originLocalId: localId });
    expect([...p.scripts.keys()]).toEqual(['login.yaml']);
    expect(p.suites.map((s) => s.name)).toEqual(['회귀']);
    expect(r).toMatchObject({ movedRuns: 1, credentialNames: ['USER_PASSWORD'], resumed: false });
    // One project in the sidebar, the cloud one, and it is the current project.
    expect(a.svc.list().map((x) => [x.name, !!x.cloud])).toEqual([['고객 포털', true]]);
    expect(a.svc.current()).toBe(cloudAppId);
    expect(existsSync(join(a.userData, 'projects', localId))).toBe(false);
    // Runs: History reads the moved index, paths point into the working copy.
    const wcDir = a.svc.store.dir(cloudAppId);
    const runs = RunIndex.with(join(wcDir, 'runs'), (idx) => idx.listRuns({ limit: 10 }));
    expect(runs.map((x) => x.id)).toEqual(['run-local-1']);
    expect(runs[0]!.dir).toBe(join(wcDir, 'runs', 'run-local-1'));
    expect(runs[0]!.scriptPath).toBe(join(wcDir, 'scripts', 'login.yaml'));
    // This PC's values: under the cloud env key, never sent (fake has no value), not in plaintext.
    const cloudEnv = compactId(p.envs[0]!.id);
    expect(a.svc.vault.names(cloudAppId, cloudEnv)).toEqual(['USER_PASSWORD']);
    expect(a.svc.vault.names(localId, envId)).toEqual([]);
    expect(readFileSync(join(a.userData, 'vault.json'), 'utf8')).not.toContain(PC_VALUE);
    expect(existsSync(join(wcDir, 'baselines', cloudEnv, 'b.png'))).toBe(true);
    // "실패 시 중단" (this PC's option) carried over; role owner after the first snapshot.
    expect(a.svc.store.require(cloudAppId).suites[0]).toMatchObject({ name: '회귀', stopOnFailure: true });
    expect(a.svc.view(cloudAppId).cloudView).toMatchObject({ role: 'owner', readOnly: false, canRun: true });
  });

  it('conversion resumes the same server project (same originLocalId → no second project)', async () => {
    const v = a.svc.create({ name: '두 번째', baseUrl: 'https://two.example.com' });
    // A first attempt that created the server project but failed before the local move.
    fake.createProject({ name: '두 번째', ownerEmail: A, origin: 'app', originLocalId: v.id });
    const r = await a.cloud.upload(v.id);
    expect(r.resumed).toBe(true);
    expect([...fake.projects.values()].filter((x) => x.name === '두 번째')).toHaveLength(1);
    expect(a.svc.list().filter((x) => x.name === '두 번째')).toHaveLength(1);
  });

  it('receive list: 내 프로젝트 / 조직 공개, received → localId; request access; runner = 실행 전용', async () => {
    b = await makePc('B', B);
    const list = await b.cloud.receiveList();
    expect(list.mine).toEqual([]);
    const item = list.org.find((x) => x.name === '고객 포털')!;
    expect(item).toMatchObject({ role: 'viewer', origin: 'app', createdBy: '소유자A', canRequestAccess: true, openRequest: null });
    const id = await b.cloud.openRemote(item.id);
    b.svc.open(id);
    expect(b.svc.view(id).cloudView).toMatchObject({ role: 'viewer', readOnly: true, canRun: false, canRequestAccess: true });
    expect((await b.cloud.receiveList()).org.find((x) => x.name === '고객 포털')?.localId).toBe(id);
    await b.cloud.requestAccess(id, 'runner', '회귀 실행');
    await expect(b.cloud.requestAccess(id, 'editor', '')).rejects.toThrow('이미 권한을 요청했습니다');
    expect((await b.cloud.myOpenRequest(id))?.role).toBe('runner');
    // The owner approves on A's PC; B's feed reflects the new role.
    const reqs = await a.cloud.accessRequests(cloudAppId);
    expect(reqs).toMatchObject([{ role: 'runner', memo: '회귀 실행', user: { email: B } }]);
    await a.cloud.decideAccess(cloudAppId, reqs[0]!.id, true);
    await until(() => b.svc.view(id).cloudView?.role === 'runner');
    expect(b.svc.view(id).cloudView).toMatchObject({ readOnly: true, canRun: true, canUpload: true });
    expect(() => b.cloud.assertWritable(id)).toThrow('실행 전용');
  });

  it('access lost: removed from a members-only project → locked; re-invited → unlocked', async () => {
    const id = compactId(fake.byName('고객 포털').id);
    fake.setVisibility(fake.byName('고객 포털'), 'members');
    await until(() => !!b.svc.view(id).cloudView?.role); // still a member (runner)
    expect(b.svc.view(id).cloudView?.accessLost).toBeUndefined();
    fake.setMember(fake.byName('고객 포털'), B, null);
    await until(() => !!b.svc.view(id).cloudView?.accessLost);
    expect(b.svc.list().find((x) => x.id === id)?.cloud?.accessLost).toBe(true);
    expect(b.svc.view(id).cloudView).toMatchObject({ readOnly: true, canRun: false });
    expect(() => b.cloud.assertWritable(id)).toThrow('접근 권한 없음');
    expect((await b.cloud.receiveList()).org.find((x) => x.name === '고객 포털')).toBeUndefined();
    fake.setMember(fake.byName('고객 포털'), B, 'editor');
    await b.cloud.refreshAccess(id);
    expect(b.svc.view(id).cloudView).toMatchObject({ role: 'editor', readOnly: false });
    expect(b.svc.view(id).cloudView?.accessLost).toBeUndefined();
  });

  it('merge: fixed target; identical → nothing to pick; differing → choices; ORIGIN_MISMATCH for someone else', async () => {
    // An old copy-upload (origin unknown): local project + its separate working copy.
    const same = a.svc.create({ name: '옛 포털', baseUrl: 'https://old.example.com' });
    a.svc.writeScript(same.id, 'a.yaml', SCRIPT('A'), 'user');
    a.svc.writeScript(same.id, 'b.yaml', SCRIPT('B'), 'user');
    fakeRun(a.svc, same.id, 'run-old-1');
    const old = fake.createProject({ name: '옛 포털', ownerEmail: A, origin: 'unknown', scripts: { 'a.yaml': SCRIPT('A'), 'b.yaml': SCRIPT('B-server') }, envs: [{ name: 'default', baseUrl: 'https://old.example.com' }] });
    const wcId = await a.cloud.openRemote(old.id);
    a.svc.store.setUploaded(same.id, { serverUrl: fake.url, projectId: old.id, localId: wcId, name: '옛 포털', at: new Date().toISOString() });
    expect(await a.cloud.mergeStatus(same.id)).toMatchObject({ ok: true, targetName: '옛 포털' });
    const plan = await a.cloud.mergePlan(same.id);
    expect(plan).toMatchObject({ sameScripts: ['a.yaml'], uploadScripts: [], runs: 1 });
    expect(plan.differ.map((d) => [d.path, d.copyPath])).toEqual([['b.yaml', 'b-로컬.yaml']]);
    await expect(a.cloud.mergeApply(same.id, { scripts: {}, suites: {} })).rejects.toThrow('고르지 않은 스크립트');
    const r = await a.cloud.mergeApply(same.id, { scripts: { 'b.yaml': 'both' }, suites: {} });
    expect(r).toEqual({ localId: wcId, movedRuns: 1 });
    expect(old.origin).toBe('app');
    expect(old.originLocalId).toBe(same.id);
    expect(old.scripts.get('b-로컬.yaml')?.source).toBe(SCRIPT('B'));
    expect(a.svc.list().filter((x) => x.name === '옛 포털').map((x) => x.id)).toEqual([wcId]);
    await until(() => a.svc.listLocalScripts(wcId).includes('b-로컬.yaml'));
    expect(RunIndex.with(join(a.svc.store.dir(wcId), 'runs'), (idx) => idx.listRuns({ limit: 10 })).map((x) => x.id)).toEqual(['run-old-1']);

    // Identical contents: nothing to pick.
    const twin = a.svc.create({ name: '쌍둥이', baseUrl: 'https://twin.example.com' });
    a.svc.writeScript(twin.id, 'a.yaml', SCRIPT('T'), 'user');
    const tp = fake.createProject({ name: '쌍둥이', ownerEmail: A, origin: 'unknown', scripts: { 'a.yaml': SCRIPT('T') } });
    a.svc.store.setUploaded(twin.id, { serverUrl: fake.url, projectId: tp.id, localId: compactId(tp.id), name: '쌍둥이', at: new Date().toISOString() });
    const tplan = await a.cloud.mergePlan(twin.id);
    expect(tplan.differ).toEqual([]);
    expect(tplan.suiteChoices).toEqual([]);
    expect(tplan.sameScripts).toEqual(['a.yaml']);
    const tr = await a.cloud.mergeApply(twin.id, { scripts: {}, suites: {} });
    expect(a.svc.list().filter((x) => x.name === '쌍둥이').map((x) => x.id)).toEqual([tr.localId]);

    // B cannot attach a local project to A's project: the server says ORIGIN_MISMATCH.
    const mine = b.svc.create({ name: '내 포털' });
    const target = fake.byName('고객 포털');
    b.svc.store.setUploaded(mine.id, { serverUrl: fake.url, projectId: target.id, localId: compactId(target.id), name: '고객 포털', at: new Date().toISOString() });
    const st = await b.cloud.mergeStatus(mine.id);
    expect(st.ok).toBe(false);
    expect(st.message).toContain('받아서 쓰세요');
    await expect(b.cloud.mergePlan(mine.id)).rejects.toThrow('합칠 수 없습니다');
    // A web project: receive-only.
    const web = fake.createProject({ name: '웹 프로젝트', ownerEmail: B, origin: 'web' });
    b.svc.store.setUploaded(mine.id, { serverUrl: fake.url, projectId: web.id, localId: compactId(web.id), name: '웹 프로젝트', at: new Date().toISOString() });
    expect((await b.cloud.mergeStatus(mine.id)).message).toContain('웹에서 만든');
  });
});

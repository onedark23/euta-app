// TEST-ONLY scripted agent (EUTA_E2E=1 + EUTA_E2E_FAKE_AGENT=1). Emits SDK-shaped
// messages — init, streamed text, tool_use, tool_result, result — and executes the
// euta tool call FOR REAL through the same gate hook and tool handlers the SDK would
// use. No model, no CLI, no network.
import { randomUUID } from 'node:crypto';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { slugify } from '@euta/core';
import type { ToolContent } from '@euta/mcp-server/tools';
import type { QueryFn } from './chat-engine.js';
import { bareToolName, EUTA_TOOL_PREFIX } from './gate.js';

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    if (signal.aborted) return rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))), { once: true });
  });

function toAnthropic(c: ToolContent): unknown {
  return c.type === 'text' ? c : { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } };
}

async function gate(options: Options, toolName: string, input: unknown, id: string, signal: AbortSignal): Promise<{ allow: boolean; reason?: string }> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback | undefined;
  if (!hook) return { allow: false, reason: 'no gate' };
  const out = (await hook({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: id, session_id: 'fake', transcript_path: '', cwd: options.cwd ?? '' } as never, id, { signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  const d = out.hookSpecificOutput;
  return d?.permissionDecision === 'allow' ? { allow: true } : { allow: false, reason: d?.permissionDecisionReason ?? 'denied' };
}

export const fakeQuery: QueryFn = async function* ({ prompt, options }, { tools }) {
  const signal = options.abortController?.signal ?? new AbortController().signal;
  const session_id = options.resume ?? randomUUID();
  const base = { parent_tool_use_id: null, uuid: randomUUID(), session_id };
  yield { type: 'system', subtype: 'init', ...base, model: 'fake-agent', cwd: options.cwd, tools: [...tools.names].map((n) => `${EUTA_TOOL_PREFIX}${n}`), mcp_servers: [{ name: 'euta', status: 'connected' }] };

  async function* say(text: string) {
    yield { type: 'stream_event', ...base, event: { type: 'message_start' } };
    for (const chunk of text.match(/.{1,6}/gsu) ?? []) {
      await sleep(40, signal);
      yield { type: 'stream_event', ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } };
    }
    yield { type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'text', text }] } };
  }

  async function* callTool(name: string, input: Record<string, unknown>) {
    const id = `toolu_fake_${randomUUID().slice(0, 8)}`;
    yield { type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
    const g = await gate(options, name, input, id, signal);
    let content: unknown[];
    let isError = false;
    if (!g.allow) {
      content = [{ type: 'text', text: g.reason }];
      isError = true;
    } else {
      const tool = tools.byName.get(bareToolName(name))!;
      const r = await tool.handler(input);
      content = r.content.map(toAnthropic);
      isError = !!r.isError;
    }
    yield { type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } };
    return content;
  }

  const t0 = Date.now();
  if (/\bbash\b/i.test(prompt)) {
    yield* say('Bash 를 시도해 봅니다.');
    yield* callTool('Bash', { command: 'ls' });
    yield* say('Bash 는 허용되지 않습니다.');
  }
  // Selector check (SPEC_선택자-점검): get_page_map → check_script_targets on a recorded run.
  const check = /selectorCheck:\s*(\S+)\s+(\S+\.ya?ml)/.exec(prompt);
  if (check) {
    const [, runId, scriptPath] = check;
    yield* say('화면 구조를 확인하겠습니다.');
    const map = (yield* callTool(`${EUTA_TOOL_PREFIX}get_page_map`, { runId })) as { type: string; text?: string }[];
    let screens = 0;
    try {
      screens = (JSON.parse(map[0]?.text ?? '{}') as { returned?: number }).returned ?? 0;
    } catch {
      /* not JSON */
    }
    const checked = (yield* callTool(`${EUTA_TOOL_PREFIX}check_script_targets`, { runId, path: scriptPath })) as { type: string; text?: string }[];
    let summary = 'unknown';
    try {
      const r = JSON.parse(checked[0]?.text ?? '{}') as { summary?: Record<string, number> };
      summary = Object.entries(r.summary ?? {})
        .filter(([, n]) => n > 0)
        .map(([v, n]) => `${v} ${n}`)
        .join(', ');
    } catch {
      /* not JSON */
    }
    yield* say(`화면 ${screens}개 · 대상 점검: ${summary}.`);
    yield { type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, num_turns: 1, result: 'ok', ...base };
    return;
  }
  const json = (c: { type: string; text?: string }[] | undefined, i = 0): Record<string, any> => {
    try {
      return JSON.parse(c?.[i]?.text ?? '{}') as Record<string, any>;
    } catch {
      return {};
    }
  };
  // TC document extraction (SPEC TC-문서-변환 "AI 추출"): get_tc_import → an invalid submit (the app
  // returns validation issues) → a fixed submit built from the first grid values.
  const extractId = /tcExtract:\s*([a-f0-9]{8,32})/.exec(prompt)?.[1];
  if (extractId) {
    yield* say('격자를 읽겠습니다.');
    const grid = (yield* callTool(`${EUTA_TOOL_PREFIX}get_tc_import`, { importId: extractId })) as { type: string; text?: string }[];
    const values = (grid[1]?.text ?? '').split('\n').map((l) => /^[A-Z]+\d+=(.+)$/.exec(l.trim())?.[1]?.trim()).filter((v): v is string => !!v);
    yield* callTool(`${EUTA_TOOL_PREFIX}save_tc_extraction`, { importId: extractId, tcs: [{ id: '', title: values[0] ?? 'TC', steps: [] }] });
    const tcs = [{ id: 'EXT-01', title: values[0] ?? '추출한 TC', category: 'AI 추출', steps: [{ no: 1, action: values[1] ?? '화면을 연다.', ...(values[2] ? { expected: values[2] } : {}) }] }];
    const ok = (yield* callTool(`${EUTA_TOOL_PREFIX}save_tc_extraction`, { importId: extractId, tcs })) as { type: string; text?: string }[];
    yield* say(`TC ${json(ok).saved ?? 0}개를 정리했습니다. 스크립트 탭 > TC 문서에서 미리보기를 확인하세요.`);
    yield { type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, num_turns: 1, result: 'ok', ...base };
    return;
  }
  // TC conversion (SPEC TC-문서-변환 "AI 변환", 2026-11-05): the app sends ONE queue item per message —
  // "tcConvert: <docId> pre-<n>" (a precondition script: save → validate → set_tc_conversion) or
  // "tcConvert: <docId> <tcId>" (get_tc → save_script → validate_script → run_script →
  // set_tc_conversion). Scripts open the fixture login page (step 1) and leave the other TC steps as
  // manual checks. Directives in the message (덧붙일 말, E2E/unit only): "pauseBetween: <ms>" waits at
  // the end of a TC item (a window to press Stop); "fakeMaxTurnsOnce: <id>" ends the first attempt of
  // that item at the round-trip limit; "fakeMaxTurnsAlways: <id>" every attempt; "fakeError: <id>" fails.
  const convert = /tcConvert:\s*([a-z0-9]{6,32})\s+(\S+)/.exec(prompt);
  if (convert) {
    const [, convertDoc, item] = convert as unknown as [string, string, string];
    const retry = /\(재시도 \d\/2\)/.test(prompt);
    const directive = (k: string) => new RegExp(`${k}:\\s*(\\S+)`).exec(prompt)?.[1];
    const pauseBetween = Number(/pauseBetween:\s*(\d+)/.exec(prompt)?.[1] ?? 1500);
    const limitHit = (directive('fakeMaxTurnsOnce') === item && !retry) || directive('fakeMaxTurnsAlways') === item;
    if (directive('fakeError') === item) throw new Error('fake agent: network down');
    // YAML header lines + steps as a JSON flow sequence (valid YAML; `name:` readable by the library list).
    const doc2yaml = (name: string, description: string, steps: unknown[]) =>
      `version: 1\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\ntarget:\n  baseUrl: \${env.BASE_URL}\nsteps: ${JSON.stringify(steps, null, 2)}\n`;
    const login = [{ goto: '/login' }, { expect: { visible: { role: 'heading', name: '로그인' } } }];
    const atLimit = { type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: Date.now() - t0, num_turns: 60, errors: ['Reached maximum number of turns (60)'], ...base };
    if (/^pre-\d+$/.test(item)) {
      const text = /사전 조건 pre-\d+:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? item;
      const file = /파일:\s*(\S+\.ya?ml)/.exec(prompt)?.[1] ?? `${item}.yaml`;
      yield* say(`사전 조건 ${item} 스크립트를 만듭니다.`);
      if (limitHit) {
        yield atLimit;
        return;
      }
      const preYaml = doc2yaml(`사전 조건: ${text}`, `사전 조건 ${item}`, [...login, { manual: { instruction: text, reason: '사전 조건 상태 확인' } }]);
      yield* callTool(`${EUTA_TOOL_PREFIX}save_script`, { path: file, yaml: preYaml, overwrite: true });
      yield* callTool(`${EUTA_TOOL_PREFIX}validate_script`, { path: file });
      yield* callTool(`${EUTA_TOOL_PREFIX}set_tc_conversion`, { docId: convertDoc, id: item, status: 'done', script: file });
      yield* say(`사전 조건 ${item} 완료 — ${file}.`);
      yield { type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, num_turns: 1, result: 'ok', ...base };
      return;
    }
    const r = json((yield* callTool(`${EUTA_TOOL_PREFIX}get_tc`, { docId: convertDoc, tcId: item })) as { type: string; text?: string }[]);
    if (limitHit) {
      yield* say(`${item} 화면을 살펴보는 중…`);
      yield atLimit;
      return;
    }
    const tc = r.tc as { id: string; title: string; steps: { no: number; action: string; expected?: string }[] };
    const groups = tc.steps.map((st, i) => ({
      group: {
        name: `${st.no}. ${st.action.replace(/\s+/g, ' ')}`,
        steps: i === 0 ? login : [{ manual: { instruction: st.expected ?? st.action, reason: '가짜 에이전트: 사람이 확인' } }],
      },
    }));
    const yaml = doc2yaml(tc.title, `TC ID: ${tc.id}`, groups.length ? groups : login);
    const file = String(r.file);
    yield* callTool(`${EUTA_TOOL_PREFIX}save_script`, { path: file, yaml, overwrite: true });
    yield* callTool(`${EUTA_TOOL_PREFIX}validate_script`, { path: file });
    const ran = json((yield* callTool(`${EUTA_TOOL_PREFIX}run_script`, { path: file })) as { type: string; text?: string }[]);
    const ok = ran.status === 'passed';
    const set = json(
      (yield* callTool(`${EUTA_TOOL_PREFIX}set_tc_conversion`, {
        docId: convertDoc,
        id: tc.id,
        status: ok ? 'done' : 'failed',
        script: file,
        ...(tc.steps.length > 2 ? { missingInfo: ['가짜 에이전트: 3단계 이후 화면 정보 없음'] } : {}),
        ...(ok ? {} : { note: `실행 결과 ${String(ran.status)}` }),
      })) as { type: string; text?: string }[],
    );
    yield* say(`${tc.id} ${ok ? '완료' : '실패'} — ${file} · 수동 ${set.manualSteps ?? 0}개.`);
    if (pauseBetween) await sleep(Math.min(pauseBetween, 30_000), signal);
    yield { type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, num_turns: 1, result: 'ok', ...base };
    return;
  }
  const recordingId = /recordingId:\s*([a-z0-9]{6,32})/.exec(prompt)?.[1];
  const editPath = /scriptEdit:\s*(\S+\.ya?ml)/.exec(prompt)?.[1];
  const path = /([\w./~-]+\.ya?ml)/.exec(prompt)?.[1];
  if (editPath) {
    // "AI에게 수정 요청": read_file → a real modification (one step appended) → save_script → validate_script.
    yield* say(`${editPath} 를 읽어 보겠습니다.`);
    const got = (yield* callTool(`${EUTA_TOOL_PREFIX}read_file`, { path: editPath })) as { type: string; text?: string }[];
    const current = got[1]?.text ?? '';
    const yaml = `${current.replace(/\n*$/, '\n')}  - measure: timing\n    name: AI 가 추가한 시간 측정\n`;
    // E2E: a deterministic window between reading and saving (someone else saves meanwhile → conflict).
    const pause = Number(/pauseBeforeSave:\s*(\d+)/.exec(prompt)?.[1] ?? 0);
    if (pause) await sleep(Math.min(pause, 30_000), signal);
    const saved = (yield* callTool(`${EUTA_TOOL_PREFIX}save_script`, { path: editPath, yaml, overwrite: true })) as { type: string; text?: string }[];
    if (/conflict/.test(saved[0]?.text ?? '')) {
      yield* say(`저장 충돌: ${saved[0]?.text ?? ''}`);
      yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 0, num_turns: 1, result: 'conflict', ...base };
      return;
    }
    const v = (yield* callTool(`${EUTA_TOOL_PREFIX}validate_script`, { path: editPath })) as { type: string; text?: string }[];
    let valid = 'unknown';
    try {
      valid = String((JSON.parse(v[0]?.text ?? '{}') as { valid?: boolean }).valid);
    } catch {
      /* not JSON */
    }
    yield* say(`바꾼 점: 마지막에 추가 — "측정: 시간" (AI 가 추가한 시간 측정). 검증: ${valid}.`);
  } else if (recordingId) {
    // Tidy a demonstration recording: get_recording → save_script → run_script (all real).
    yield* say('녹화를 확인하겠습니다.');
    const got = (yield* callTool(`${EUTA_TOOL_PREFIX}get_recording`, { recordingId })) as { type: string; text?: string }[];
    let name = 'recording';
    try {
      name = (JSON.parse(got[0]?.text ?? '{}') as { name?: string }).name ?? name;
    } catch {
      /* not JSON */
    }
    const draft = got[1]?.text ?? '';
    const yaml = `${draft.replace(/\n*$/, '\n')}  - measure: [web-vitals, timing]\n    name: 주요 화면 측정 (AI 정리)\n`;
    const out = `${slugify(name, 'recording')}-ai.yaml`;
    yield* say(`초안을 다듬어 ${out} 로 저장합니다.`);
    yield* callTool(`${EUTA_TOOL_PREFIX}save_script`, { path: out, yaml, overwrite: true });
    const ran = (yield* callTool(`${EUTA_TOOL_PREFIX}run_script`, { path: out })) as { type: string; text?: string }[];
    let status = 'unknown';
    try {
      status = (JSON.parse(ran[0]?.text ?? '{}') as { status?: string }).status ?? status;
    } catch {
      /* not JSON */
    }
    yield* say(`정리한 스크립트 ${out} 실행 결과: ${status}.`);
  } else if (path) {
    yield* say(`스크립트 ${path} 를 실행하겠습니다.`);
    const content = (yield* callTool(`${EUTA_TOOL_PREFIX}run_script`, { path })) as { type: string; text?: string }[];
    let status = 'unknown';
    try {
      status = (JSON.parse(content[0]?.text ?? '{}') as { status?: string }).status ?? status;
    } catch {
      /* not JSON */
    }
    yield* say(`실행 결과: ${status}.`);
  } else if (!/\bbash\b/i.test(prompt)) {
    yield* say('(fake agent) 실행할 YAML 경로를 알려 주세요.');
  }
  yield { type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, num_turns: 1, result: 'ok', ...base };
};

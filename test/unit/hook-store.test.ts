import { describe, expect, it } from 'vitest';
import { HookStore, isEutaTool } from '../../src/main/hook-store.js';

describe('HookStore', () => {
  it('groups hook payloads per session and classifies them', () => {
    const s = new HookStore();
    s.ingest({ session_id: 'a', hook_event_name: 'SessionStart', source: 'startup', cwd: '/w' });
    s.ingest({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'run the login test' });
    s.ingest({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_euta_euta__run_script', tool_use_id: 't1', tool_input: { path: '/x.yaml' } });
    s.ingest({ session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_euta_euta__run_script', tool_use_id: 't1', tool_response: { status: 'passed' } });
    s.ingest({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'ls' } });
    s.ingest({ session_id: 'a', hook_event_name: 'Notification', message: 'Claude needs your permission' });
    s.ingest({ session_id: 'a', hook_event_name: 'Stop' });
    s.ingest({ session_id: 'b', hook_event_name: 'UserPromptSubmit', prompt: 'other' });
    const list = s.list();
    expect(list.map((x) => x.sessionId).sort()).toEqual(['a', 'b']);
    const a = list.find((x) => x.sessionId === 'a')!;
    expect(a.cwd).toBe('/w');
    expect(a.entries.map((e) => e.kind)).toEqual(['session', 'prompt', 'tool', 'tool', 'notification', 'stop']);
    expect(a.entries[1]?.summary).toBe('run the login test');
    const euta = a.entries[2]!;
    expect(euta.isEuta).toBe(true);
    expect(euta.status).toBe('done');
    expect(euta.input).toContain('/x.yaml');
    expect(euta.detail).toContain('passed');
    expect(a.entries[3]?.isEuta).toBe(false);
    expect(a.entries[3]?.status).toBe('running');
  });

  it('pairs tool calls by session_id + tool_use_id even when Post arrives before Pre', () => {
    const s = new HookStore();
    s.ingest({ session_id: 'a', hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__euta__session_step', tool_use_id: 'x', error: 'timeout' });
    s.ingest({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'mcp__euta__session_step', tool_use_id: 'x', tool_input: { step: { click: 'OK' } } });
    // Same tool_use_id in another session is a different call.
    s.ingest({ session_id: 'b', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'x' });
    const a = s.list().find((x) => x.sessionId === 'a')!;
    expect(a.entries).toHaveLength(1);
    const e = a.entries[0]!;
    expect(e.status).toBe('failed');
    expect(e.event).toBe('PostToolUseFailure');
    expect(e.detail).toContain('timeout');
    expect(e.input).toContain('click');
    expect(e.isEuta).toBe(true);
    expect(s.list().find((x) => x.sessionId === 'b')!.entries[0]?.status).toBe('running');
  });

  it('pairs subagents by agent_id and handles StopFailure', () => {
    const s = new HookStore();
    s.ingest({ session_id: 'a', hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'Explore' });
    s.ingest({ session_id: 'a', hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore' });
    s.ingest({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g', agent_id: 'ag1' });
    s.ingest({ session_id: 'a', hook_event_name: 'StopFailure', error: 'rate_limit' });
    const a = s.list()[0]!;
    expect(a.entries.map((e) => e.kind)).toEqual(['subagent', 'tool', 'stop']);
    expect(a.entries[0]?.status).toBe('done');
    expect(a.entries[0]?.summary).toBe('subagent Explore finished');
    expect(a.entries[1]?.agentId).toBe('ag1');
    expect(a.entries[2]?.status).toBe('failed');
    expect(a.entries[2]?.summary).toContain('rate_limit');
  });

  it('rejects non-hook payloads and truncates huge fields', () => {
    const s = new HookStore();
    expect(s.ingest(null)).toBeUndefined();
    expect(s.ingest([1])).toBeUndefined();
    expect(s.ingest({ session_id: 'x' })).toBeUndefined();
    const e = s.ingest({ session_id: 'x', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r', tool_response: { content: 'y'.repeat(100_000) } })!;
    expect(e.detail!.length).toBeLessThan(5000);
  });

  it('recognizes euta tools (manual registration and plugin-scoped)', () => {
    expect(isEutaTool('mcp__euta__run_script')).toBe(true);
    expect(isEutaTool('mcp__plugin_euta_euta__session_step')).toBe(true);
    expect(isEutaTool('mcp__plugin_euta-claude-plugin_euta__get_run')).toBe(true);
    expect(isEutaTool('mcp__other__run')).toBe(false);
    expect(isEutaTool('mcp__eutaX__run')).toBe(false);
    expect(isEutaTool('Bash')).toBe(false);
    expect(isEutaTool(undefined)).toBe(false);
  });
});

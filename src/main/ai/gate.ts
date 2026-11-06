// Tool-call gate for the in-app AI chat (ADR-015). Deny by default: only the tools
// of euta's own in-process SDK MCP server are allowed. Used by both the PreToolUse
// hook and canUseTool so every path reaches the same decision.

/** Name of the in-process SDK MCP server (tools appear as mcp__euta__<tool>). */
export const EUTA_SERVER = 'euta';
export const EUTA_TOOL_PREFIX = `mcp__${EUTA_SERVER}__`;

export type GateDecision = { behavior: 'allow' } | { behavior: 'deny'; reason: string };

/** Where an MCP tool came from (SDK `mcp_server` / canUseTool `mcpServer`). */
export interface ToolProvenance {
  name?: string;
  source?: string;
}

export function bareToolName(name: string): string {
  return name.startsWith(EUTA_TOOL_PREFIX) ? name.slice(EUTA_TOOL_PREFIX.length) : name;
}

/**
 * Allow iff the tool is one of euta's registered in-process tools. When the SDK
 * reports provenance, it must be the host-registered (`source: 'sdk'`) server
 * named `euta` — a configured server with the same name is not trusted.
 */
export function decideTool(toolName: string, allowed: ReadonlySet<string>, provenance?: ToolProvenance): GateDecision {
  if (!toolName.startsWith(EUTA_TOOL_PREFIX)) {
    return { behavior: 'deny', reason: `Tool "${toolName}" is not available in euta chat. Use the euta tools (mcp__euta__*) only.` };
  }
  const bare = bareToolName(toolName);
  if (!allowed.has(bare)) return { behavior: 'deny', reason: `Unknown euta tool "${bare}".` };
  if (provenance && (provenance.source !== undefined || provenance.name !== undefined)) {
    if (provenance.source !== 'sdk' || provenance.name !== EUTA_SERVER) {
      return { behavior: 'deny', reason: `Tool "${toolName}" does not come from euta's in-process server.` };
    }
  }
  return { behavior: 'allow' };
}

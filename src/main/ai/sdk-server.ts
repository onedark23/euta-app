// euta tools as an in-process Agent SDK MCP server (createSdkMcpServer + tool()).
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { EutaTool } from '@euta/mcp-server/tools';
import { EUTA_SERVER } from './gate.js';

/** The two SDK functions this module needs (injected so the SDK is loaded lazily). */
export interface SdkToolApi {
  tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
  createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
}

export function createEutaSdkServer(sdk: SdkToolApi, tools: EutaTool[], version = '0.1.0'): McpSdkServerConfigWithInstance {
  return sdk.createSdkMcpServer({
    name: EUTA_SERVER,
    version,
    tools: tools.map((t) =>
      sdk.tool(
        t.name,
        t.description,
        t.inputShape,
        // The handler validates, redacts (SecretGuard) and maps errors itself.
        async (args) => (await t.handler(args)) as Awaited<ReturnType<Parameters<SdkToolApi['tool']>[3]>>,
        t.annotations ? { annotations: t.annotations } : undefined,
      ),
    ),
  });
}

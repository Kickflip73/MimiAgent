import { createHash } from 'node:crypto';
import {
  Agent,
  getAllMcpTools,
  RunContext,
  type MCPServer,
  type Model,
  type Tool,
} from '@openai/agents';
import type { ExecutionLedger } from '../core/execution-ledger.js';

interface RunIdentity {
  sessionId: string;
  runId: string;
  semanticCallIds?: boolean;
  authorizeSideEffect?: (toolName: string, argumentsJson: string) => Promise<void>;
  sanitizeResult?: <T>(value: T) => T;
  sanitizeError?: (error: unknown) => unknown;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  )).join(',')}}`;
}

async function invokeMcp<T>(
  server: MCPServer,
  toolName: string,
  args: Record<string, unknown> | null,
  ledger: ExecutionLedger,
  currentRun: () => RunIdentity | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const run = currentRun();
  const argumentsJson = stableJson(args ?? {});
  const ledgerToolName = `mcp:${server.name}:${toolName}`;
  const invokeAuthorized = async () => {
    await run?.authorizeSideEffect?.(ledgerToolName, argumentsJson);
    try {
      const result = await operation();
      return run?.sanitizeResult?.(result) ?? result;
    } catch (error) {
      throw run?.sanitizeError?.(error) ?? error;
    }
  };
  if (!run?.semanticCallIds) return invokeAuthorized();
  const callId = createHash('sha256')
    .update(`${server.name}\0${toolName}\0${argumentsJson}`)
    .digest('hex');
  return ledger.executeOnce({
    sessionId: run.sessionId,
    runId: run.runId,
    toolName: ledgerToolName,
    callId,
    argumentsJson,
  }, invokeAuthorized);
}

/**
 * MCP tools are converted to Function Tools inside the Agents SDK, after the
 * normal Function Tool ledger wrapper runs. Proxy their transport calls so a
 * durable Daemon retry cannot silently repeat a completed or uncertain MCP
 * transaction.
 */
export function withMcpExecutionLedger(
  servers: readonly MCPServer[],
  ledger: ExecutionLedger,
  currentRun: () => RunIdentity | undefined,
): MCPServer[] {
  return servers.map((server) => new Proxy(server, {
    get(target, property) {
      if (property === 'callTool') {
        return (
          toolName: string,
          args: Record<string, unknown> | null,
          meta?: Record<string, unknown> | null,
        ) => invokeMcp(target, toolName, args, ledger, currentRun, () => target.callTool(toolName, args, meta));
      }
      if (property === 'callToolResult' && typeof target.callToolResult === 'function') {
        return (
          toolName: string,
          args: Record<string, unknown> | null,
          meta?: Record<string, unknown> | null,
        ) => invokeMcp(
          target,
          toolName,
          args,
          ledger,
          currentRun,
          () => target.callToolResult!(toolName, args, meta),
        );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
}

export async function materializeMcpTools<TContext = unknown>(input: {
  servers: readonly MCPServer[];
  ledger: ExecutionLedger;
  currentRun: () => RunIdentity | undefined;
  model: string | Model;
  reservedTools: Tool<TContext>[];
  context?: TContext;
}): Promise<Tool<TContext>[]> {
  if (!input.servers.length) return [];
  const wrapped = withMcpExecutionLedger(input.servers, input.ledger, input.currentRun);
  const catalogAgent = new Agent<TContext>({
    name: 'MimiAgent MCP capability catalog',
    model: input.model,
    instructions: '',
    tools: input.reservedTools,
  });
  const runContext = new RunContext(input.context as TContext);
  return getAllMcpTools({
    mcpServers: wrapped,
    runContext,
    agent: catalogAgent,
    convertSchemasToStrict: true,
    includeServerInToolNames: true,
    reservedToolNames: new Set(input.reservedTools.map((tool) => tool.name)),
  });
}

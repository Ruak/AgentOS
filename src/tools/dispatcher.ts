import { EventLog } from "../kernel/event-log.ts";
import { ProcessManager } from "../kernel/process-manager.ts";
import type { JSONSchema, SyscallRequest, SyscallResult } from "../types.ts";
import { ToolRegistry } from "./registry.ts";

export class ToolDispatcher {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly eventLog: EventLog,
    private readonly processManager: ProcessManager
  ) {}

  async dispatch(request: SyscallRequest, runId: string): Promise<SyscallResult> {
    const started = Date.now();
    const tool = this.registry.get(request.syscall);
    const permissions = this.processManager.getPermissions(request.pid);
    const missing = tool.manifest.permissions.filter((permission) => !permissions.includes(permission));

    this.eventLog.append({
      runId,
      pid: request.pid,
      type: "tool.requested",
      payload: {
        syscall: request.syscall,
        reason: request.reason,
        sideEffects: tool.manifest.sideEffects
      }
    });

    if (missing.length > 0) {
      return this.fail(runId, request.pid, request.syscall, started, "permission_denied", `Missing permissions: ${missing.join(", ")}`);
    }

    const validationError = validateInput(tool.manifest.inputSchema, request.args);
    if (validationError) {
      return this.fail(runId, request.pid, request.syscall, started, "invalid_args", validationError);
    }

    try {
      const data = await withTimeout(
        Promise.resolve(tool.handler(request.args, { pid: request.pid, runId, manifest: tool.manifest })),
        tool.manifest.timeoutMs,
        request.syscall
      );
      const result: SyscallResult = {
        ok: true,
        data,
        cost: {
          timeMs: Date.now() - started
        }
      };
      this.eventLog.append({
        runId,
        pid: request.pid,
        type: "tool.completed",
        payload: {
          syscall: request.syscall,
          ok: true,
          cost: result.cost
        }
      });
      return result;
    } catch (error) {
      return this.fail(runId, request.pid, request.syscall, started, "tool_error", error instanceof Error ? error.message : String(error));
    }
  }

  private fail(runId: string, pid: string, syscall: string, started: number, code: string, message: string): SyscallResult {
    const result: SyscallResult = {
      ok: false,
      error: { code, message },
      cost: {
        timeMs: Date.now() - started
      }
    };
    this.eventLog.append({
      runId,
      pid,
      type: "tool.completed",
      payload: {
        syscall,
        ok: false,
        error: result.error,
        cost: result.cost
      }
    });
    return result;
  }
}

function validateInput(schema: JSONSchema, value: unknown): string | undefined {
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return "Expected an object argument";
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && (!value || typeof value !== "object" || !(key in value))) {
      return `Missing required argument: ${key}`;
    }
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms: ${name}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

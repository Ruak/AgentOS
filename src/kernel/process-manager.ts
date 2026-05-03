import type { AgentMessage, AgentProcess, AgentSpec, Budget, Capability } from "../types.ts";

let processSeq = 0;
let threadSeq = 0;

export class ProcessManager {
  private readonly specs = new Map<string, AgentSpec>();
  private readonly processes = new Map<string, AgentProcess>();

  register(spec: AgentSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`Agent spec already registered: ${spec.id}`);
    }
    this.specs.set(spec.id, spec);
  }

  getSpec(specId: string): AgentSpec {
    const spec = this.specs.get(specId);
    if (!spec) throw new Error(`Unknown agent spec: ${specId}`);
    return spec;
  }

  listSpecs(): AgentSpec[] {
    return [...this.specs.values()];
  }

  createProcess(specId: string, budget: Budget = {}): AgentProcess {
    const spec = this.getSpec(specId);
    const now = new Date().toISOString();
    const process: AgentProcess = {
      pid: `pid_${++processSeq}`,
      specId: spec.id,
      status: "idle",
      mailbox: [],
      contextState: {
        threadId: `thr_${++threadSeq}`,
        summaries: [],
        retrieved: []
      },
      budget: {
        maxTokens: budget.maxTokens ?? 8_000,
        maxToolCalls: budget.maxToolCalls ?? 8,
        deadlineMs: budget.deadlineMs
      },
      createdAt: now,
      updatedAt: now
    };
    this.processes.set(process.pid, process);
    return process;
  }

  getProcess(pid: string): AgentProcess {
    const process = this.processes.get(pid);
    if (!process) throw new Error(`Unknown process: ${pid}`);
    return process;
  }

  getPermissions(pid: string): Capability[] {
    const process = this.getProcess(pid);
    return this.getSpec(process.specId).permissions;
  }

  setStatus(pid: string, status: AgentProcess["status"]): AgentProcess {
    const process = this.getProcess(pid);
    process.status = status;
    process.updatedAt = new Date().toISOString();
    return process;
  }

  postMessage(pid: string, message: AgentMessage): void {
    const process = this.getProcess(pid);
    process.mailbox.push(message);
    process.updatedAt = new Date().toISOString();
  }
}

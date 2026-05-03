import { SimpleContextManager } from "../context/context-manager.ts";
import type { ChatMessage, Run, ToolCall } from "../types.ts";
import type { EventLog } from "./event-log.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { ToolDispatcher } from "../tools/dispatcher.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { RuntimeAdapter } from "../types.ts";

let runSeq = 0;

export type OrchestratorResult = {
  run: Run;
  output: string;
  messages: ChatMessage[];
};

export type OrchestratorOptions = {
  runId?: string;
  guidanceProvider?: (runId: string) => string[];
  maxTokens?: number;
  maxToolCalls?: number;
};

export class Orchestrator {
  constructor(
    private readonly processManager: ProcessManager,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolDispatcher: ToolDispatcher,
    private readonly contextManager: SimpleContextManager,
    private readonly runtime: RuntimeAdapter,
    private readonly eventLog: EventLog
  ) {}

  async runAgent(specId: string, input: string, options: OrchestratorOptions = {}): Promise<OrchestratorResult> {
    const process = this.processManager.createProcess(specId, {
      maxTokens: options.maxTokens,
      maxToolCalls: options.maxToolCalls
    });
    const agent = this.processManager.getSpec(specId);
    const run: Run = {
      id: options.runId ?? `run_${++runSeq}`,
      pid: process.pid,
      input,
      status: "running",
      startedAt: new Date().toISOString()
    };

    this.eventLog.append({ runId: run.id, pid: process.pid, type: "agent.created", payload: { specId } });
    this.processManager.setStatus(process.pid, "running");
    this.eventLog.append({ runId: run.id, pid: process.pid, type: "agent.started", payload: { input } });

    try {
      const compiled = await this.contextManager.buildPrompt(run, agent, process.contextState.retrieved);
      this.eventLog.append({
        runId: run.id,
        pid: process.pid,
        type: "context.compiled",
        payload: {
          tokenEstimate: compiled.tokenEstimate,
          sources: compiled.sources
        }
      });

      const messages = [...compiled.messages];
      let output = "";
      let toolCalls = 0;

      for (let turn = 0; turn < 6; turn++) {
        const guidance = options.guidanceProvider?.(run.id) ?? [];
        for (const item of guidance) {
          messages.push({
            role: "system",
            content: `User guidance added during this run:\n${item}\nApply this guidance in the next action.`
          });
          this.eventLog.append({
            runId: run.id,
            pid: process.pid,
            type: "user.guidance.applied",
            payload: { guidance: item }
          });
        }
        const tools = this.toolRegistry.listForNames(agent.tools);
        this.eventLog.append({ runId: run.id, pid: process.pid, type: "model.called", payload: { turn } });
        const modelResponse = await this.withModelHeartbeat(run.id, process.pid, turn, () =>
          this.runtime.complete({ run, agent, messages, tools })
        );
        this.eventLog.append({
          runId: run.id,
          pid: process.pid,
          type: "model.completed",
          payload: {
            turn,
            usage: modelResponse.usage,
            hasToolCalls: Boolean(modelResponse.toolCalls?.length),
            contentPreview: modelResponse.content ? modelResponse.content.slice(0, 500) : undefined,
            toolCalls: modelResponse.toolCalls?.map((call) => ({ name: call.name, args: call.args }))
          }
        });
        output = modelResponse.content;
        messages.push({
          role: "assistant",
          content: modelResponse.content,
          toolCalls: modelResponse.toolCalls,
          reasoningContent: modelResponse.reasoningContent
        });

        if (!modelResponse.toolCalls?.length) break;
        if (turn === 5) {
          for (const call of modelResponse.toolCalls) {
            this.appendToolNotExecuted(run, messages, call, "turn_limit_reached", "Tool call turn limit reached. No more tools may be executed in this run.");
          }
          output = await this.finalizeFromToolResults(run, agent, messages);
          break;
        }
        for (const call of modelResponse.toolCalls) {
          toolCalls++;
          if (toolCalls > process.budget.maxToolCalls) {
            this.appendToolNotExecuted(run, messages, call, "tool_budget_exceeded", "Tool call budget exceeded. No more tools may be executed in this run.");
            for (const remainingCall of modelResponse.toolCalls.slice(modelResponse.toolCalls.indexOf(call) + 1)) {
              this.appendToolNotExecuted(run, messages, remainingCall, "tool_budget_exceeded", "Tool call budget exceeded. No more tools may be executed in this run.");
            }
            output = await this.finalizeFromToolResults(run, agent, messages);
            break;
          }
          await this.handleToolCall(run, messages, call);
        }
        if (toolCalls > process.budget.maxToolCalls) break;
      }

      run.status = "completed";
      run.completedAt = new Date().toISOString();
      this.processManager.setStatus(process.pid, "terminated");
      this.eventLog.append({ runId: run.id, pid: process.pid, type: "agent.terminated", payload: { status: run.status } });
      return { run, output, messages };
    } catch (error) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      this.processManager.setStatus(process.pid, "failed");
      this.eventLog.append({ runId: run.id, pid: process.pid, type: "error.raised", payload: { error: run.error } });
      throw error;
    }
  }

  private async handleToolCall(run: Run, messages: ChatMessage[], call: ToolCall): Promise<void> {
    const result = await this.toolDispatcher.dispatch(
      {
        pid: run.pid,
        syscall: call.name,
        args: call.args,
        reason: `model_tool_call:${call.id}`
      },
      run.id
    );
    messages.push({
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: JSON.stringify(result, null, 2)
    });
  }

  private appendToolNotExecuted(run: Run, messages: ChatMessage[], call: ToolCall, code: string, message: string): void {
    const result = {
      ok: false,
      error: {
        code,
        message
      }
    };
    this.eventLog.append({
      runId: run.id,
      pid: run.pid,
      type: "tool.completed",
      payload: {
        syscall: call.name,
        ok: false,
        error: result.error
      }
    });
    messages.push({
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: JSON.stringify(result, null, 2)
    });
  }

  private async finalizeFromToolResults(run: Run, agent: import("../types.ts").AgentSpec, messages: ChatMessage[]): Promise<string> {
    const finalMessages: ChatMessage[] = [
      ...messages,
      {
        role: "system",
        content:
          "Tool-call budget is exhausted. Do not call any more tools. Produce the final user-facing answer now using the available tool results. If evidence is incomplete, state that clearly and cite any mounted paths you have."
      }
    ];
    this.eventLog.append({ runId: run.id, pid: run.pid, type: "model.called", payload: { turn: "finalize" } });
    const response = await this.withModelHeartbeat(run.id, run.pid, "finalize", () =>
      this.runtime.complete({
        run,
        agent,
        messages: finalMessages,
        tools: []
      })
    );
    this.eventLog.append({
      runId: run.id,
      pid: run.pid,
      type: "model.completed",
      payload: {
        turn: "finalize",
        usage: response.usage,
        hasToolCalls: Boolean(response.toolCalls?.length),
        contentPreview: response.content ? response.content.slice(0, 500) : undefined
      }
    });
    if (response.content) return response.content;
    return "Run reached the tool-call budget, but the model did not produce final content. Review the event log for the last tool results.";
  }

  private async withModelHeartbeat<T>(runId: string, pid: string, turn: number | string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const timer = setInterval(() => {
      this.eventLog.append({
        runId,
        pid,
        type: "model.heartbeat",
        payload: {
          turn,
          elapsedMs: Date.now() - started,
          note: "Model call is still running"
        }
      });
    }, 2_500);
    try {
      return await action();
    } finally {
      clearInterval(timer);
    }
  }
}

import type {
  AgentSpec,
  CompiledContext,
  ContextSource,
  MemoryChunk,
  Run,
  Summary,
  TokenBudget
} from "../types.ts";
import { MemoryStore } from "./memory-store.ts";

let summarySeq = 0;

export class SimpleContextManager {
  constructor(private readonly memoryStore: MemoryStore) {}

  async buildPrompt(run: Run, agent: AgentSpec, retrieved: MemoryChunk[] = []): Promise<CompiledContext> {
    const memory = await this.selectMemories(run.input, { maxTokens: Math.floor((agent.memoryPolicy.maxItems ?? 5) * 200) });
    const sources: ContextSource[] = [];
    const messages = [
      {
        role: "system" as const,
        content: agent.systemPrompt
      }
    ];
    sources.push(source("system", agent.id, agent.systemPrompt));

    const memoryText = [...memory, ...retrieved]
      .map((chunk) => `[${chunk.source}] ${chunk.content}`)
      .join("\n\n");
    if (memoryText) {
      messages.push({
        role: "system" as const,
        content: `Mounted context:\n${memoryText}`
      });
      for (const chunk of [...memory, ...retrieved]) {
        sources.push(source(chunk.source.startsWith("/") ? "rag" : "memory", chunk.source, chunk.content, chunk.id));
      }
    }

    messages.push({
      role: "user" as const,
      content: run.input
    });
    sources.push(source("input", run.id, run.input));

    return {
      messages,
      sources,
      tokenEstimate: estimateTokens(messages.map((message) => message.content).join("\n"))
    };
  }

  async selectMemories(query: string, budget: TokenBudget): Promise<MemoryChunk[]> {
    const chunks = this.memoryStore.search(query, 8);
    const selected: MemoryChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const cost = estimateTokens(chunk.content);
      if (used + cost > budget.maxTokens) continue;
      selected.push(chunk);
      used += cost;
    }
    return selected;
  }

  async summarizeThread(threadId: string): Promise<Summary> {
    return {
      id: `sum_${++summarySeq}`,
      content: `Summary placeholder for ${threadId}`,
      createdAt: new Date().toISOString()
    };
  }

  evict(_strategy: "lru" | "priority" | "deadline" | "semantic"): void {
    return;
  }
}

function source(kind: ContextSource["kind"], sourceId: string, content: string, id = sourceId): ContextSource {
  return {
    id,
    kind,
    source: sourceId,
    tokenEstimate: estimateTokens(content)
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

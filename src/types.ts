export type JSONSchema = Record<string, unknown>;
export type Capability = string;

export type MemoryPolicy = {
  scope: "ephemeral" | "durable";
  maxItems?: number;
};

export type AgentStatus = "idle" | "running" | "blocked" | "failed" | "terminated";
export type TaskStatus = "pending" | "running" | "blocked" | "done" | "failed";

export type Budget = {
  maxTokens?: number;
  maxToolCalls?: number;
  deadlineMs?: number;
  timeoutMs?: number;
  retries?: number;
};

export type AgentSpec = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  tools: string[];
  memoryPolicy: MemoryPolicy;
  permissions: Capability[];
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
};

export type AgentProcess = {
  pid: string;
  specId: string;
  status: AgentStatus;
  mailbox: AgentMessage[];
  contextState: ContextState;
  budget: Required<Pick<Budget, "maxTokens" | "maxToolCalls">> & Pick<Budget, "deadlineMs">;
  createdAt: string;
  updatedAt: string;
};

export type AgentMessage = {
  from: string;
  to: string | "broadcast";
  type: "task" | "result" | "question" | "event" | "error";
  payload: unknown;
  correlationId?: string;
  priority: number;
  createdAt: string;
};

export type Task = {
  id: string;
  goal: string;
  assignedTo?: string;
  dependencies: string[];
  priority: number;
  status: TaskStatus;
  budget: Budget;
};

export type Event = {
  id: string;
  runId: string;
  pid?: string;
  type: string;
  timestamp: string;
  payload: unknown;
};

export type EventQuery = {
  runId?: string;
  pid?: string;
  type?: string;
};

export type Run = {
  id: string;
  pid: string;
  input: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
};

export type ContextState = {
  threadId: string;
  summaries: Summary[];
  retrieved: MemoryChunk[];
};

export type Summary = {
  id: string;
  content: string;
  createdAt: string;
};

export type MemoryChunk = {
  id: string;
  content: string;
  source: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type TokenBudget = {
  maxTokens: number;
};

export type ContextSource = {
  id: string;
  kind: "system" | "input" | "memory" | "rag" | "tool";
  source: string;
  tokenEstimate: number;
};

export type CompiledContext = {
  messages: ChatMessage[];
  sources: ContextSource[];
  tokenEstimate: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
};

export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  permissions: Capability[];
  sideEffects: "none" | "read" | "write" | "network" | "destructive";
  timeoutMs: number;
};

export type SyscallRequest = {
  pid: string;
  syscall: string;
  args: unknown;
  reason?: string;
};

export type SyscallResult = {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  cost?: {
    timeMs: number;
    tokens?: number;
  };
};

export type ToolExecutionContext = {
  pid: string;
  runId: string;
  manifest: ToolManifest;
};

export type ToolHandler = (
  args: unknown,
  context: ToolExecutionContext
) => Promise<unknown> | unknown;

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ModelRequest = {
  run: Run;
  agent: AgentSpec;
  messages: ChatMessage[];
  tools: ToolManifest[];
};

export type ModelResponse = {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
};

export interface RuntimeAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type FileStat = {
  path: string;
  size: number;
  modifiedAt: string;
  kind: "file" | "directory";
};

export type Range = {
  offset?: number;
  length?: number;
};

export type ContentChunk = {
  path: string;
  content: string;
  offset: number;
};

export type SearchQuery = {
  path?: string;
  query: string;
  limit?: number;
};

export type SearchResult = {
  path: string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type EventHandler = (event: Event) => void;

export interface FileSystemDriver {
  stat(path: string): Promise<FileStat>;
  read(path: string, range?: Range): Promise<ContentChunk>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  watch?(path: string, callback: EventHandler): void;
}

export interface KnowledgeFS {
  mount(path: string, driver: FileSystemDriver): void;
  stat(path: string): Promise<FileStat>;
  read(path: string, range?: Range): Promise<ContentChunk>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  watch(path: string, callback: EventHandler): void;
}

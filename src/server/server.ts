import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import {
  DeepSeekRuntimeAdapter,
  EventLog,
  LocalFileSystemDriver,
  MemoryStore,
  MockRuntimeAdapter,
  MountedKnowledgeFS,
  Orchestrator,
  ProcessManager,
  SimpleContextManager,
  ToolDispatcher,
  ToolRegistry
} from "../index.ts";
import { loadEnv } from "../config/env.ts";
import type { AgentSpec, Event, Run, SearchQuery } from "../types.ts";
import { buildWorkspaceContext, renderWorkspaceContext } from "./workspace-context.ts";

loadEnv();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const publicRoot = resolve(repoRoot, "src/server/public");
const eventLog = new EventLog();
const processManager = new ProcessManager();
const toolRegistry = new ToolRegistry();
const knowledgeFS = new MountedKnowledgeFS();
const memoryStore = new MemoryStore();
const contextManager = new SimpleContextManager(memoryStore);
const dispatcher = new ToolDispatcher(toolRegistry, eventLog, processManager);
const mockRuntime = new MockRuntimeAdapter();
const KNOWLEDGE_SEARCH_TOOL = "knowledge_search";
const WORKSPACE_LIST_TOOL = "workspace_list";
const WORKSPACE_READ_TOOL = "workspace_read";
const WORKSPACE_MKDIR_TOOL = "workspace_mkdir";
const WORKSPACE_WRITE_TOOL = "workspace_write";
const COMMAND_RUN_TOOL = "command_run";
const runs = new Map<
  string,
  {
    runId: string;
    status: Run["status"];
    agentId?: string;
    runtime?: "mock" | "deepseek";
    input?: string;
    workspacePath?: string;
    deliveryPath?: string;
    output?: string;
    error?: string;
    events: Event[];
  }
>();
const runGuidance = new Map<string, Array<{ text: string; delivered: boolean; createdAt: string }>>();

knowledgeFS.mount("/workspace", new LocalFileSystemDriver(repoRoot));

toolRegistry.register(
  {
    name: KNOWLEDGE_SEARCH_TOOL,
    description:
      "Search the selected workspace. The user's working directory is mounted at /workspace; use /workspace when the user says this directory, current directory, project, or workspace.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" }
      }
    },
    outputSchema: { type: "array" },
    permissions: ["knowledge:read"],
    sideEffects: "read",
    timeoutMs: 5_000
  },
  async (args) => {
    const query = args as SearchQuery;
    return knowledgeFS.search({
      path: normalizeWorkspacePath(query.path),
      query: query.query,
      limit: query.limit ?? 5
    });
  }
);

toolRegistry.register(
  {
    name: WORKSPACE_LIST_TOOL,
    description:
      "List files and folders inside the selected workspace. Use this before editing when you need to understand the directory structure.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "number" }
      }
    },
    outputSchema: { type: "object" },
    permissions: ["workspace:read"],
    sideEffects: "read",
    timeoutMs: 5_000
  },
  async (args) => {
    const body = args as { path?: string; dir?: string; directory?: string; folder?: string; depth?: number };
    return listWorkspace(repoRoot, firstString(body.path, body.dir, body.directory, body.folder) ?? "/workspace", body.depth ?? 2);
  }
);

toolRegistry.register(
  {
    name: WORKSPACE_READ_TOOL,
    description:
      "Read one text file from the selected workspace. Paths are relative to /workspace, for example /workspace/README.md or README.md.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" }
      }
    },
    outputSchema: { type: "object" },
    permissions: ["workspace:read"],
    sideEffects: "read",
    timeoutMs: 5_000
  },
  async (args) => {
    const body = args as { path?: string; file?: string; filepath?: string; filePath?: string; maxBytes?: number };
    const requestedPath = requiredPath(firstString(body.path, body.file, body.filepath, body.filePath), WORKSPACE_READ_TOOL);
    const filePath = resolveWorkspaceFile(repoRoot, requestedPath);
    const content = await readWorkspaceTextFile(repoRoot, filePath, requestedPath);
    const maxBytes = body.maxBytes ?? 24_000;
    return {
      path: toWorkspacePath(repoRoot, filePath),
      content: content.slice(0, maxBytes),
      truncated: content.length > maxBytes
    };
  }
);

toolRegistry.register(
  {
    name: WORKSPACE_WRITE_TOOL,
    description:
      "Create or replace a file inside the selected workspace. Use only when the user has granted workspace:write permission.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      }
    },
    outputSchema: { type: "object" },
    permissions: ["workspace:write"],
    sideEffects: "write",
    timeoutMs: 5_000
  },
  async (args) => {
    const body = args as { path?: string; file?: string; filepath?: string; filePath?: string; content?: string; data?: string; text?: string };
    const requestedPath = requiredPath(firstString(body.path, body.file, body.filepath, body.filePath), WORKSPACE_WRITE_TOOL);
    const content = firstString(body.content, body.data, body.text) ?? "";
    const filePath = resolveWorkspaceFile(repoRoot, requestedPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return {
      path: toWorkspacePath(repoRoot, filePath),
      bytes: Buffer.byteLength(content, "utf8")
    };
  }
);

toolRegistry.register(
  {
    name: WORKSPACE_MKDIR_TOOL,
    description:
      "Create a directory inside the selected workspace. Use this instead of shell mkdir. Paths are relative to /workspace.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" }
      }
    },
    outputSchema: { type: "object" },
    permissions: ["workspace:write"],
    sideEffects: "write",
    timeoutMs: 5_000
  },
  async (args) => {
    const body = args as { path?: string; dir?: string; directory?: string; folder?: string };
    const requestedPath = requiredPath(firstString(body.path, body.dir, body.directory, body.folder), WORKSPACE_MKDIR_TOOL);
    const dirPath = resolveWorkspaceFile(repoRoot, requestedPath);
    await mkdir(dirPath, { recursive: true });
    return {
      path: toWorkspacePath(repoRoot, dirPath)
    };
  }
);

toolRegistry.register(
  {
    name: COMMAND_RUN_TOOL,
    description:
      "Run an allowlisted verification command in the selected workspace, such as npm test, npm run build, pnpm test, pytest, or node --check <file>.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number" }
      }
    },
    outputSchema: { type: "object" },
    permissions: ["command:run"],
    sideEffects: "read",
    timeoutMs: 30_000
  },
  async (args) => {
    const body = args as { command: string; timeoutMs?: number };
    return runAllowedCommand(repoRoot, body.command, body.timeoutMs ?? 30_000);
  }
);

const baseToolManifests = [
  toolRegistry.get(KNOWLEDGE_SEARCH_TOOL).manifest,
  toolRegistry.get(WORKSPACE_LIST_TOOL).manifest,
  toolRegistry.get(WORKSPACE_READ_TOOL).manifest,
  toolRegistry.get(WORKSPACE_WRITE_TOOL).manifest,
  toolRegistry.get(WORKSPACE_MKDIR_TOOL).manifest,
  toolRegistry.get(COMMAND_RUN_TOOL).manifest
];

processManager.register({
  id: "builder",
  name: "Workspace Builder",
  role: "Search mounted project knowledge and summarize results.",
  systemPrompt:
    "You are an AgentOS worker process. The user-selected working directory is mounted at /workspace. Work like a careful human operator: inspect the workspace, plan briefly, read relevant files, make permitted edits, run allowed verification commands when useful, then deliver a concise summary of what changed and any remaining risks. For product/design/system-building tasks, create usable deliverable files under /workspace/.agentos/deliverables when workspace_write is available, such as HTML/CSS/JS prototypes, specs, schemas, workflows, or runnable examples. Do not stop at a report when the task asks for a usable product or experience. Use workspace_mkdir or workspace_write to create directories/files; do not use command_run for mkdir, copy, move, delete, or shell filesystem changes. Do not ask for the path unless /workspace access fails. If workspace:write permission is unavailable, provide an exact file plan instead of pretending to write. If command:run is unavailable, do not attempt command execution.",
  tools: [KNOWLEDGE_SEARCH_TOOL, WORKSPACE_LIST_TOOL, WORKSPACE_READ_TOOL, WORKSPACE_MKDIR_TOOL, WORKSPACE_WRITE_TOOL, COMMAND_RUN_TOOL],
  memoryPolicy: {
    scope: "ephemeral",
    maxItems: 5
  },
  permissions: ["knowledge:read", "workspace:read", "workspace:write", "command:run"]
});

processManager.register({
  id: "researcher",
  name: "Workspace Researcher",
  role: "Read mounted project knowledge and summarize results.",
  systemPrompt:
    "You are an AgentOS read-only research process. The user-selected working directory is mounted at /workspace. Inspect the workspace, cite paths, and deliver concise analysis. Do not attempt writes or command execution.",
  tools: [KNOWLEDGE_SEARCH_TOOL, WORKSPACE_LIST_TOOL, WORKSPACE_READ_TOOL],
  memoryPolicy: {
    scope: "ephemeral",
    maxItems: 5
  },
  permissions: ["knowledge:read", "workspace:read"]
});

let runSeq = 0;

type RunRequestBody = {
  agentId: string;
  input: string;
  runtime?: "mock" | "deepseek";
  workspacePath?: string;
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/") {
      return serveFile(response, "index.html");
    }
    if (request.method === "GET" && ["/app.js", "/styles.css"].includes(url.pathname)) {
      return serveFile(response, url.pathname.slice(1));
    }
    if (request.method === "GET" && url.pathname === "/api/agents") {
      return json(response, processManager.listSpecs());
    }
    if (request.method === "POST" && url.pathname === "/api/agents") {
      return createAgent(request, response);
    }
    if (request.method === "GET" && url.pathname === "/api/tools") {
      return json(response, toolRegistry.list());
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      return createRun(request, response);
    }
    if (request.method === "POST" && /^\/api\/runs\/[^/]+\/guidance$/.test(url.pathname)) {
      const runId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return addGuidance(request, response, runId);
    }
    if (request.method === "POST" && /^\/api\/runs\/[^/]+\/followups$/.test(url.pathname)) {
      const runId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return createFollowup(request, response, runId);
    }
    if (request.method === "GET" && /^\/api\/runs\/[^/]+$/.test(url.pathname)) {
      const runId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      return json(response, runs.get(runId) ?? { runId, status: "failed", error: "Unknown run" }, runs.has(runId) ? 200 : 404);
    }
    if (request.method === "GET" && /^\/api\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const runId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return streamEvents(response, runId);
    }
    return json(response, { error: "Not found" }, 404);
  } catch (error) {
    return json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

const port = Number(process.env.AGENTOS_PORT ?? 8787);
server.listen(port, () => {
  console.log(`AgentOS console listening at http://localhost:${port}`);
});

async function createAgent(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson<Partial<AgentSpec> & { id?: string }>(request);
  const id = sanitizeId(body.id || body.name || `agent_${Date.now()}`);
  const permissions = body.permissions ?? [];
  const tools = normalizeTools(body.tools?.length ? body.tools : [KNOWLEDGE_SEARCH_TOOL, WORKSPACE_LIST_TOOL, WORKSPACE_READ_TOOL, WORKSPACE_MKDIR_TOOL, WORKSPACE_WRITE_TOOL, COMMAND_RUN_TOOL])
    .filter((tool) => tool !== WORKSPACE_WRITE_TOOL || permissions.includes("workspace:write"))
    .filter((tool) => tool !== WORKSPACE_MKDIR_TOOL || permissions.includes("workspace:write"))
    .filter((tool) => tool !== WORKSPACE_READ_TOOL || permissions.includes("workspace:read"))
    .filter((tool) => tool !== WORKSPACE_LIST_TOOL || permissions.includes("workspace:read"))
    .filter((tool) => tool !== COMMAND_RUN_TOOL || permissions.includes("command:run"));
  const spec: AgentSpec = {
    id,
    name: body.name || id,
    role: body.role || "User-defined AgentOS process.",
    systemPrompt: body.systemPrompt || "You are an AgentOS process. Follow kernel permissions and use syscall tools when needed.",
    tools,
    memoryPolicy: body.memoryPolicy ?? {
      scope: "ephemeral",
      maxItems: 5
    },
    permissions
  };
  processManager.register(spec);
  json(response, spec, 201);
}

async function createRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson<RunRequestBody>(request);
  return startRun(body, response);
}

async function startRun(body: RunRequestBody, response: ServerResponse): Promise<void> {
  if (!body.agentId || !body.input) {
    return json(response, { error: "agentId and input are required" }, 400);
  }

  const runId = `run_ui_${++runSeq}`;
  const workspacePath = resolve(body.workspacePath || repoRoot);
  const deliveryPath = resolve(workspacePath, ".agentos", "runs", runId, "result.md");
  runs.set(runId, {
    runId,
    status: "running",
    agentId: body.agentId,
    runtime: body.runtime ?? "mock",
    input: body.input,
    workspacePath,
    deliveryPath,
    events: []
  });
  json(response, { runId, status: "running" }, 202);

  const workspaceContext = await buildWorkspaceContext(workspacePath);
  const agentInput = buildWorkspaceTaskInput(body.input, workspacePath, renderWorkspaceContext(workspaceContext));
  const runtime = body.runtime === "deepseek" ? new DeepSeekRuntimeAdapter() : mockRuntime;
  const scoped = createScopedRuntime(workspacePath);
  const orchestrator = new Orchestrator(processManager, scoped.toolRegistry, scoped.dispatcher, contextManager, runtime, eventLog);

  orchestrator
    .runAgent(body.agentId, agentInput, {
      runId,
      guidanceProvider: drainGuidance,
      maxToolCalls: 100,
      maxTokens: 32_000
    })
    .then(async (result) => {
      await deliverResult(deliveryPath, {
        runId,
        workspacePath,
        input: body.input,
        output: result.output,
        events: eventLog.replay(runId)
      });
      const record = runs.get(runId);
      if (!record) return;
      record.status = result.run.status;
      record.output = result.output;
      record.events = eventLog.replay(runId);
      record.deliveryPath = deliveryPath;
    })
    .catch(async (error) => {
      const record = runs.get(runId);
      if (!record) return;
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.events = eventLog.replay(runId);
      await deliverResult(deliveryPath, {
        runId,
        workspacePath,
        input: body.input,
        output: "",
        error: record.error,
        events: record.events
      });
    });
}

async function addGuidance(request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> {
  const record = runs.get(runId);
  if (!record) return json(response, { error: "Unknown run" }, 404);
  const body = await readJson<{ text?: string }>(request);
  const text = body.text?.trim();
  if (!text) return json(response, { error: "text is required" }, 400);
  const list = runGuidance.get(runId) ?? [];
  list.push({ text, delivered: false, createdAt: new Date().toISOString() });
  runGuidance.set(runId, list);
  eventLog.append({
    runId,
    type: "user.guidance.received",
    payload: { text }
  });
  json(response, { ok: true });
}

async function createFollowup(request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> {
  const previous = runs.get(runId);
  if (!previous) return json(response, { error: "Unknown run" }, 404);
  const body = await readJson<{ input?: string }>(request);
  const input = body.input?.trim();
  if (!input) return json(response, { error: "input is required" }, 400);
  const followupInput = [
    "Continue from the previous AgentOS run.",
    "",
    `Previous run: ${runId}`,
    previous.output ? `Previous output:\n${previous.output}` : previous.error ? `Previous error:\n${previous.error}` : "Previous run has no final output.",
    "",
    "Follow-up instruction:",
    input
  ].join("\n");
  return startRun({
    agentId: previous.agentId ?? "builder",
    input: followupInput,
    runtime: previous.runtime ?? "mock",
    workspacePath: previous.workspacePath
  }, response);
}

function drainGuidance(runId: string): string[] {
  const list = runGuidance.get(runId) ?? [];
  const pending = list.filter((item) => !item.delivered);
  for (const item of pending) item.delivered = true;
  return pending.map((item) => item.text);
}

function createScopedRuntime(workspacePath: string): { toolRegistry: ToolRegistry; dispatcher: ToolDispatcher } {
  const scopedRegistry = new ToolRegistry();
  const scopedKnowledge = new MountedKnowledgeFS();
  scopedKnowledge.mount("/workspace", new LocalFileSystemDriver(workspacePath));
  scopedRegistry.register(baseToolManifests[0], async (args) => {
    const query = args as SearchQuery;
    return scopedKnowledge.search({
      path: normalizeWorkspacePath(query.path),
      query: query.query,
      limit: query.limit ?? 5
    });
  });
  scopedRegistry.register(baseToolManifests[1], async (args) => {
    const body = args as { path?: string; dir?: string; directory?: string; folder?: string; depth?: number };
    return listWorkspace(workspacePath, firstString(body.path, body.dir, body.directory, body.folder) ?? "/workspace", body.depth ?? 2);
  });
  scopedRegistry.register(baseToolManifests[2], async (args) => {
    const body = args as { path?: string; file?: string; filepath?: string; filePath?: string; maxBytes?: number };
    const requestedPath = requiredPath(firstString(body.path, body.file, body.filepath, body.filePath), WORKSPACE_READ_TOOL);
    const filePath = resolveWorkspaceFile(workspacePath, requestedPath);
    const content = await readWorkspaceTextFile(workspacePath, filePath, requestedPath);
    const maxBytes = body.maxBytes ?? 24_000;
    return {
      path: toWorkspacePath(workspacePath, filePath),
      content: content.slice(0, maxBytes),
      truncated: content.length > maxBytes
    };
  });
  scopedRegistry.register(baseToolManifests[3], async (args) => {
    const body = args as { path?: string; file?: string; filepath?: string; filePath?: string; content?: string; data?: string; text?: string };
    const requestedPath = requiredPath(firstString(body.path, body.file, body.filepath, body.filePath), WORKSPACE_WRITE_TOOL);
    const content = firstString(body.content, body.data, body.text) ?? "";
    const filePath = resolveWorkspaceFile(workspacePath, requestedPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return {
      path: toWorkspacePath(workspacePath, filePath),
      bytes: Buffer.byteLength(content, "utf8")
    };
  });
  scopedRegistry.register(baseToolManifests[4], async (args) => {
    const body = args as { path?: string; dir?: string; directory?: string; folder?: string };
    const requestedPath = requiredPath(firstString(body.path, body.dir, body.directory, body.folder), WORKSPACE_MKDIR_TOOL);
    const dirPath = resolveWorkspaceFile(workspacePath, requestedPath);
    await mkdir(dirPath, { recursive: true });
    return {
      path: toWorkspacePath(workspacePath, dirPath)
    };
  });
  scopedRegistry.register(baseToolManifests[5], async (args) => {
    const body = args as { command: string; timeoutMs?: number };
    return runAllowedCommand(workspacePath, body.command, body.timeoutMs ?? 30_000);
  });
  return {
    toolRegistry: scopedRegistry,
    dispatcher: new ToolDispatcher(scopedRegistry, eventLog, processManager)
  };
}

async function deliverResult(
  path: string,
  delivery: { runId: string; workspacePath: string; input: string; output: string; error?: string; events: Event[] }
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = [
    `# AgentOS Run ${delivery.runId}`,
    "",
    `Workspace: ${delivery.workspacePath}`,
    "",
    "## Task",
    "",
    delivery.input,
    "",
    "## Result",
    "",
    delivery.error ? `Failed: ${delivery.error}` : delivery.output,
    "",
    "## Event Summary",
    "",
    ...delivery.events.map((event) => {
      if (event.type === "tool.requested" || event.type === "tool.completed") {
        const payload = event.payload as { syscall?: string; ok?: boolean; error?: { message?: string } };
        return `- ${event.timestamp} ${event.type} ${payload.syscall ?? ""} ${payload.ok === false ? `failed: ${payload.error?.message ?? ""}` : ""}`.trim();
      }
      return `- ${event.timestamp} ${event.type}`;
    })
  ].join("\n");
  await writeFile(path, content, "utf8");
}

function streamEvents(response: ServerResponse, runId: string): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });

  for (const event of eventLog.replay(runId)) {
    writeSse(response, event);
  }

  const unsubscribe = eventLog.subscribe((event) => {
    if (event.runId === runId) {
      writeSse(response, event);
    }
  });
  response.on("close", unsubscribe);
}

function writeSse(response: ServerResponse, event: Event): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function serveFile(response: ServerResponse, name: string): Promise<void> {
  const path = resolve(publicRoot, name);
  if (!path.startsWith(publicRoot)) {
    return json(response, { error: "Invalid path" }, 400);
  }
  const content = await readFile(path);
  response.writeHead(200, { "Content-Type": contentType(name) });
  response.end(content);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

function json(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function contentType(name: string): string {
  if (name.endsWith(".js")) return "text/javascript";
  if (name.endsWith(".css")) return "text/css";
  return "text/html; charset=utf-8";
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `agent_${Date.now()}`;
}

function normalizeTools(tools: string[]): string[] {
  return tools.map((tool) => (tool === "knowledge.search" ? KNOWLEDGE_SEARCH_TOOL : tool));
}

function normalizeWorkspacePath(path?: string): string {
  if (!path || path === "." || path === "/" || path === "./") {
    return "/workspace";
  }
  if (path === "workspace") {
    return "/workspace";
  }
  if (path.startsWith("./")) {
    return `/workspace/${path.slice(2)}`;
  }
  if (!path.startsWith("/")) {
    return `/workspace/${path}`;
  }
  return path;
}

function buildWorkspaceTaskInput(input: string, workspacePath: string, workspaceContext: string): string {
  return [
    `Workspace mount: /workspace`,
    `Host path: ${workspacePath}`,
    "",
    "Instruction: The user-selected directory has already been read by AgentOS. Use the Workspace Context below as the primary evidence. If the task asks to design, build, complete, improve, or make a product, you must create concrete deliverable files under /workspace/.agentos/deliverables using workspace_mkdir/workspace_write when permission exists. Prefer a directly usable HTML/CSS/JS prototype or structured project artifacts over a pure report. Inspect with workspace_list/workspace_read, edit with workspace_write only when permission exists, and verify with command_run only when permission exists. Do not use command_run for mkdir/cp/mv/rm or filesystem changes. Do not ask the user to provide a path before using /workspace.",
    "",
    workspaceContext,
    "",
    "User task:",
    input
  ].join("\n");
}

function resolveWorkspaceFile(workspacePath: string, requestedPath: string): string {
  const root = resolve(workspacePath);
  const normalized = normalizeWorkspacePath(requestedPath);
  const relativePath = normalized.replace(/^\/workspace\/?/, "");
  const filePath = resolve(root, relativePath);
  const rootLower = root.toLowerCase();
  const fileLower = filePath.toLowerCase();
  if (fileLower !== rootLower && !fileLower.startsWith(`${rootLower}${sep}`)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return filePath;
}

function resolveWorkspacePath(workspacePath: string, requestedPath: string): string {
  return resolveWorkspaceFile(workspacePath, requestedPath);
}

function toWorkspacePath(workspacePath: string, filePath: string): string {
  const root = resolve(workspacePath);
  const relativePath = filePath.slice(root.length).replace(/\\/g, "/").replace(/^\/+/, "");
  return relativePath ? `/workspace/${relativePath}` : "/workspace";
}

async function listWorkspace(workspacePath: string, requestedPath: string, depth: number): Promise<{ root: string; entries: Array<{ path: string; kind: "file" | "directory" }> }> {
  const rootPath = resolveWorkspacePath(workspacePath, requestedPath);
  const entries: Array<{ path: string; kind: "file" | "directory" }> = [];
  await walkList(workspacePath, rootPath, Math.max(0, Math.min(depth, 4)), entries);
  return {
    root: toWorkspacePath(workspacePath, rootPath),
    entries
  };
}

async function walkList(
  workspacePath: string,
  currentPath: string,
  depth: number,
  entries: Array<{ path: string; kind: "file" | "directory" }>
): Promise<void> {
  const { readdir, stat } = await import("fs/promises");
  const info = await stat(currentPath);
  if (info.isFile()) {
    entries.push({ path: toWorkspacePath(workspacePath, currentPath), kind: "file" });
    return;
  }
  const dirents = await readdir(currentPath, { withFileTypes: true });
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if ([".git", "node_modules", "dist", ".agentos"].includes(dirent.name)) continue;
    const child = resolve(currentPath, dirent.name);
    entries.push({ path: toWorkspacePath(workspacePath, child), kind: dirent.isDirectory() ? "directory" : "file" });
    if (dirent.isDirectory() && depth > 1) {
      await walkList(workspacePath, child, depth - 1, entries);
    }
  }
}

async function runAllowedCommand(workspacePath: string, command: string, timeoutMs: number): Promise<{ command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const parsed = parseAllowedCommand(command);
  if (!parsed) {
    throw new Error(`Command is not allowlisted: ${command}`);
  }

  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(parsed.command, parsed.args, {
      cwd: workspacePath,
      shell: false,
      windowsHide: true
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.min(timeoutMs, 60_000));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk).slice(0, 40_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 40_000);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        command,
        exitCode,
        stdout: stdout.slice(0, 40_000),
        stderr: stderr.slice(0, 40_000),
        timedOut
      });
    });
  });
}

function parseAllowedCommand(command: string): { command: string; args: string[] } | undefined {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const [bin, ...args] = parts;
  const joined = parts.join(" ");
  const exact = new Set([
    "npm test",
    "npm run test",
    "npm run build",
    "pnpm test",
    "pnpm run build",
    "yarn test",
    "yarn build",
    "pytest",
    "pytest -q"
  ]);
  if (exact.has(joined)) return { command: bin, args };
  if (bin === "node" && args[0] === "--check" && args.length === 2 && !args[1].includes("..")) {
    return { command: bin, args };
  }
  return undefined;
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function requiredPath(path: string | undefined, tool: string): string {
  if (!path) {
    throw new Error(`${tool} requires a path`);
  }
  return path;
}

async function readWorkspaceTextFile(workspacePath: string, filePath: string, requestedPath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      const directory = dirname(filePath);
      let candidates: string[] = [];
      try {
        const names = await readdir(directory);
        candidates = names.slice(0, 40).map((name) => toWorkspacePath(workspacePath, resolve(directory, name)));
      } catch {
        candidates = [];
      }
      throw new Error(
        [
          `File not found: ${requestedPath}`,
          candidates.length ? `Nearby files:\n${candidates.map((item) => `- ${item}`).join("\n")}` : "No nearby files could be listed.",
          "Use workspace_list to inspect the directory before reading guessed paths."
        ].join("\n")
      );
    }
    throw error;
  }
}

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
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
import type { AgentSpec, SearchQuery } from "../types.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");

const eventLog = new EventLog();
const processManager = new ProcessManager();
const toolRegistry = new ToolRegistry();
const knowledgeFS = new MountedKnowledgeFS();
const memoryStore = new MemoryStore();
const contextManager = new SimpleContextManager(memoryStore);

knowledgeFS.mount("/workspace", new LocalFileSystemDriver(repoRoot));

toolRegistry.register(
  {
    name: "knowledge_search",
    description: "Search mounted knowledge sources.",
    inputSchema: {
      type: "object",
      required: ["query"]
    },
    outputSchema: {
      type: "object"
    },
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

const dispatcher = new ToolDispatcher(toolRegistry, eventLog, processManager);
const runtime = new MockRuntimeAdapter();
const orchestrator = new Orchestrator(processManager, toolRegistry, dispatcher, contextManager, runtime, eventLog);

const agent: AgentSpec = {
  id: "researcher",
  name: "Workspace Researcher",
  role: "Search mounted project knowledge and summarize results.",
  systemPrompt: "You are a managed AgentOS process. Use mounted knowledge only through syscall tools.",
  tools: ["knowledge_search"],
  memoryPolicy: {
    scope: "ephemeral",
    maxItems: 5
  },
  permissions: ["knowledge:read"]
};

processManager.register(agent);

const input = process.argv.slice(2).join(" ") || "Search the workspace for AgentOS PRD and summarize matching files.";
const result = await orchestrator.runAgent(agent.id, input);

console.log(JSON.stringify(
  {
    run: result.run,
    output: result.output,
    events: eventLog.replay(result.run.id)
  },
  null,
  2
));

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

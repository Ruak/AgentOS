const state = {
  agents: [],
  currentRunId: "",
  events: 0,
  source: null,
  heartbeatItems: new Map()
};

const taskForm = document.querySelector("#taskForm");
const agentSelect = document.querySelector("#agentSelect");
const agentCount = document.querySelector("#agentCount");
const eventCount = document.querySelector("#eventCount");
const runState = document.querySelector("#runState");
const activeRun = document.querySelector("#activeRun");
const eventLog = document.querySelector("#eventLog");
const resultBox = document.querySelector("#resultBox");

document.querySelector("#createAgent").addEventListener("click", createAgent);
document.querySelector("#loadResult").addEventListener("click", loadResult);
document.querySelector("#sendGuidance").addEventListener("click", sendGuidance);
document.querySelector("#runFollowup").addEventListener("click", runFollowup);
document.querySelector("#clearEvents").addEventListener("click", () => {
  eventLog.innerHTML = "";
  state.events = 0;
  eventCount.textContent = "0";
});

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runTask();
});

await loadAgents();

async function loadAgents() {
  state.agents = await api("/api/agents");
  agentCount.textContent = String(state.agents.length);
  agentSelect.innerHTML = "";

  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.name} (${agent.permissions.join(", ") || "no permissions"})`;
    agentSelect.appendChild(option);
  }
  const builder = state.agents.find((agent) => agent.id === "builder");
  if (builder) agentSelect.value = builder.id;
}

async function createAgent() {
  const name = document.querySelector("#agentName").value.trim() || "Workspace Operator";
  const systemPrompt = document.querySelector("#systemPrompt").value.trim();
  const canRead = document.querySelector("#knowledgePermission").checked;
  const canWrite = document.querySelector("#writePermission").checked;
  const canRunCommand = document.querySelector("#commandPermission").checked;
  const permissions = [];
  if (canRead) permissions.push("knowledge:read", "workspace:read");
  if (canWrite) permissions.push("workspace:write");
  if (canRunCommand) permissions.push("command:run");
  const agent = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name,
      role: "Operate inside a user-selected workspace.",
      systemPrompt,
      permissions,
      tools: ["knowledge_search", "workspace_list", "workspace_read", "workspace_mkdir", "workspace_write", "command_run"]
    })
  });
  await loadAgents();
  agentSelect.value = agent.id;
}

async function runTask() {
  const workspacePath = document.querySelector("#workspacePath").value.trim();
  const input = document.querySelector("#taskInput").value.trim();
  const agentId = agentSelect.value;
  const runtime = document.querySelector("#runtimeSelect").value;
  if (!input || !agentId) return;

  eventLog.innerHTML = "";
  renderMarkdown("Task submitted. AgentOS is preparing the workspace runtime.");
  state.events = 0;
  eventCount.textContent = "0";
  runState.textContent = "running";

  const created = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ agentId, input, runtime, workspacePath })
  });

  state.currentRunId = created.runId;
  activeRun.textContent = created.runId;
  connectEvents(created.runId);
}

function connectEvents(runId) {
  if (state.source) state.source.close();
  state.source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  for (const type of [
    "agent.created",
    "agent.started",
    "context.compiled",
    "model.called",
    "model.heartbeat",
    "model.completed",
    "tool.requested",
    "tool.completed",
    "agent.terminated",
    "error.raised"
  ]) {
    state.source.addEventListener(type, appendEvent);
  }
}

async function loadResult() {
  if (!state.currentRunId) return;
  const result = await api(`/api/runs/${encodeURIComponent(state.currentRunId)}`);
  runState.textContent = readableState(result.status);
  const output = result.output || (result.status === "running" ? "The task is still running. Refresh later." : "No final output was produced.");
  renderMarkdown([
    `Status: ${readableState(result.status)}`,
    result.workspacePath ? `Workspace: ${result.workspacePath}` : "",
    result.deliveryPath ? `Delivery file: ${result.deliveryPath}` : "",
    result.error ? `Error: ${result.error}` : "",
    "",
    output
  ].filter(Boolean).join("\n"));
  if (result.status !== "running" && state.source) {
    state.source.close();
  }
}

async function sendGuidance() {
  if (!state.currentRunId) return;
  const text = document.querySelector("#guidanceInput").value.trim();
  if (!text) return;
  await api(`/api/runs/${encodeURIComponent(state.currentRunId)}/guidance`, {
    method: "POST",
    body: JSON.stringify({ text })
  });
  document.querySelector("#guidanceInput").value = "";
}

async function runFollowup() {
  if (!state.currentRunId) return;
  const input = document.querySelector("#guidanceInput").value.trim();
  if (!input) return;
  const created = await api(`/api/runs/${encodeURIComponent(state.currentRunId)}/followups`, {
    method: "POST",
    body: JSON.stringify({ input })
  });
  eventLog.innerHTML = "";
  resultBox.innerHTML = "";
  state.events = 0;
  eventCount.textContent = "0";
  state.currentRunId = created.runId;
  activeRun.textContent = created.runId;
  connectEvents(created.runId);
  document.querySelector("#guidanceInput").value = "";
}

function appendEvent(message) {
  const event = JSON.parse(message.data);
  runState.textContent = event.type === "agent.terminated" ? "completed" : event.type === "error.raised" ? "failed" : "running";

  if (event.type === "model.heartbeat") {
    upsertHeartbeatEvent(event);
    return;
  }

  state.events += 1;
  eventCount.textContent = String(state.events);

  const item = document.createElement("div");
  item.className = `event ${event.type.includes("error") ? "error" : event.type.includes("tool") ? "tool" : ""}`;
  item.innerHTML = `<strong>${labelForEvent(event.type)}</strong><span>${event.timestamp}</span><div>${escapeHtml(summaryForEvent(event))}</div>`;
  eventLog.appendChild(item);
  eventLog.scrollTop = eventLog.scrollHeight;

  if (event.type === "agent.terminated" || event.type === "error.raised") {
    setTimeout(loadResult, 200);
  }
}

function upsertHeartbeatEvent(event) {
  const key = `${event.runId}:${event.payload.turn}`;
  let item = state.heartbeatItems.get(key);
  if (!item) {
    state.events += 1;
    eventCount.textContent = String(state.events);
    item = document.createElement("div");
    item.className = "event";
    eventLog.appendChild(item);
    state.heartbeatItems.set(key, item);
  }
  item.innerHTML = `<strong>${labelForEvent(event.type)}</strong><span>${event.timestamp}</span><div>${escapeHtml(summaryForEvent(event))}</div>`;
  eventLog.scrollTop = eventLog.scrollHeight;
}

function labelForEvent(type) {
  const labels = {
    "agent.created": "Create agent process",
    "agent.started": "Start task",
    "context.compiled": "Compile context",
    "model.called": "Call model",
    "model.heartbeat": "Model still running",
    "model.completed": "Model completed",
    "tool.requested": "Request tool syscall",
    "tool.completed": "Tool syscall completed",
    "agent.terminated": "Task completed",
    "error.raised": "Run failed",
    "user.guidance.received": "User guidance received",
    "user.guidance.applied": "User guidance applied"
  };
  return labels[type] || type;
}

function summaryForEvent(event) {
  if (event.type === "tool.requested") return `Calling ${event.payload.syscall}`;
  if (event.type === "tool.completed") return event.payload.ok ? "Tool succeeded" : JSON.stringify(event.payload.error);
  if (event.type === "context.compiled") return `Estimated ${event.payload.tokenEstimate} tokens`;
  if (event.type === "model.heartbeat") return `Waiting for model response, elapsed ${Math.round(event.payload.elapsedMs / 1000)}s`;
  if (event.type === "model.completed") {
    const preview = event.payload.contentPreview ? `: ${event.payload.contentPreview}` : "";
    return event.payload.hasToolCalls ? `Model requested a tool${preview}` : `Model produced final content${preview}`;
  }
  if (event.type === "error.raised") return event.payload.error;
  return JSON.stringify(event.payload);
}

function readableState(status) {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "running" ? "running" : status;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function renderMarkdown(markdown) {
  resultBox.innerHTML = markdownToHtml(markdown);
}

function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = "";

  function closeList() {
    if (listType) {
      html.push(`</${listType}>`);
      listType = "";
    }
  }

  function closeCode() {
    if (inCode) {
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      inCode = false;
      codeLines = [];
    }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) closeCode();
      else {
        closeList();
        inCode = true;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    if (trimmed.startsWith("> ")) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }

  closeCode();
  closeList();
  return html.join("\n");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

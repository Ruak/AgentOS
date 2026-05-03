# AgentOS

AgentOS is a minimal Agent microkernel inspired by operating-system primitives:

- Agent process management.
- Tool use as syscall dispatch.
- Context window as a cache layer.
- RAG as mounted knowledge filesystems.
- Orchestrator as kernel runtime.
- Event log for replay and observability.

## Run

```bash
npm run build
npm run example:single
```

The first example registers one managed agent, mounts the repository as `/workspace`, exposes a `knowledge_search` syscall, and records the whole run in the event log. It uses Node 22's built-in TypeScript stripping so the MVP can run without installing packages.

## Console

```bash
npm run console
```

Open `http://localhost:8787` to select a working directory, publish a task, watch progress, and inspect the delivered result.

Current workspace flow:

1. Enter a local working directory.
2. Describe the task.
3. Choose Mock for offline testing or DeepSeek for real model execution.
4. AgentOS mounts that directory as `/workspace`.
5. AgentOS scans text-like files in the directory and injects a bounded workspace context into the model prompt.
6. The result is written to `.agentos/runs/<runId>/result.md` inside the selected directory.

The core tool surface is intentionally small:

- `knowledge_search`: search the mounted workspace.
- `workspace_list`: list files and folders inside the mounted workspace.
- `workspace_read`: read a specific text file from the mounted workspace.
- `workspace_mkdir`: create a directory inside the mounted workspace when `workspace:write` is granted.
- `workspace_write`: create or replace a file inside the mounted workspace when `workspace:write` is granted.
- `command_run`: run allowlisted verification commands when `command:run` is granted.

AgentOS proactively reads text-like workspace files into context, tools can inspect or modify the mounted directory when permissions allow, and AgentOS writes the final delivery file. Command execution is intentionally left as a separate allowlisted syscall layer rather than exposed as a default tool.

For product-building tasks, use the `Workspace Builder` agent. It can create deliverables under `.agentos/deliverables` when write permission is available. The console also supports live guidance during a run and follow-up modification runs after a result is delivered.

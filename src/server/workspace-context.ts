import { readdir, readFile, stat } from "fs/promises";
import { join, relative, resolve } from "path";

export type WorkspaceContextOptions = {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
};

export type WorkspaceContext = {
  root: string;
  files: Array<{
    path: string;
    size: number;
    includedBytes: number;
    content: string;
  }>;
  skipped: Array<{
    path: string;
    reason: string;
  }>;
  totalBytes: number;
};

const DEFAULT_OPTIONS: Required<WorkspaceContextOptions> = {
  maxFiles: 40,
  maxBytesPerFile: 12_000,
  maxTotalBytes: 80_000
};

const EXCLUDED_NAMES = new Set([".git", "node_modules", "dist", ".agentos", ".DS_Store"]);

export async function buildWorkspaceContext(root: string, options: WorkspaceContextOptions = {}): Promise<WorkspaceContext> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const resolvedRoot = resolve(root);
  const files = await walk(resolvedRoot);
  const context: WorkspaceContext = {
    root: resolvedRoot,
    files: [],
    skipped: [],
    totalBytes: 0
  };

  for (const file of files.slice(0, config.maxFiles)) {
    const virtualPath = toVirtualPath(resolvedRoot, file);
    const info = await stat(file);
    if (!isTextLike(file)) {
      context.skipped.push({ path: virtualPath, reason: "non-text file" });
      continue;
    }
    if (context.totalBytes >= config.maxTotalBytes) {
      context.skipped.push({ path: virtualPath, reason: "context budget reached" });
      continue;
    }

    const remaining = config.maxTotalBytes - context.totalBytes;
    const budget = Math.min(config.maxBytesPerFile, remaining);
    const raw = await readFile(file, "utf8");
    const content = raw.slice(0, budget);
    context.files.push({
      path: virtualPath,
      size: info.size,
      includedBytes: Buffer.byteLength(content, "utf8"),
      content
    });
    context.totalBytes += Buffer.byteLength(content, "utf8");
  }

  if (files.length > config.maxFiles) {
    for (const file of files.slice(config.maxFiles)) {
      context.skipped.push({ path: toVirtualPath(resolvedRoot, file), reason: "file limit reached" });
    }
  }

  return context;
}

export function renderWorkspaceContext(context: WorkspaceContext): string {
  const sections = [
    "# Workspace Context",
    "",
    `Mounted root: /workspace`,
    `Host root: ${context.root}`,
    `Included files: ${context.files.length}`,
    `Included bytes: ${context.totalBytes}`,
    ""
  ];

  if (context.files.length > 0) {
    sections.push("## Included File Contents", "");
    for (const file of context.files) {
      sections.push(`### ${file.path}`, "");
      sections.push("```text");
      sections.push(file.content);
      sections.push("```", "");
    }
  }

  if (context.skipped.length > 0) {
    sections.push("## Skipped Files", "");
    for (const skipped of context.skipped.slice(0, 80)) {
      sections.push(`- ${skipped.path}: ${skipped.reason}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

async function walk(root: string): Promise<string[]> {
  const info = await stat(root);
  if (info.isFile()) return [root];

  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function toVirtualPath(root: string, file: string): string {
  return `/workspace/${relative(root, file).replace(/\\/g, "/")}`;
}

function isTextLike(path: string): boolean {
  return /\.(md|txt|csv|ts|tsx|js|jsx|json|yaml|yml|html|css|xml|sql|py|java|go|rs|c|cpp|h|hpp)$/i.test(path);
}

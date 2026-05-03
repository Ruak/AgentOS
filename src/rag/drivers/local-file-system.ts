import { readdir, readFile, stat as fsStat } from "fs/promises";
import { join, relative, resolve } from "path";
import type { ContentChunk, FileStat, FileSystemDriver, Range, SearchQuery, SearchResult } from "../../types.ts";
import { scoreText, tokenize } from "../../context/memory-store.ts";

const DEFAULT_EXCLUDES = new Set([".git", "node_modules", "dist", ".DS_Store"]);

export class LocalFileSystemDriver implements FileSystemDriver {
  private readonly root: string;

  constructor(root: string, private readonly excludes = DEFAULT_EXCLUDES) {
    this.root = resolve(root);
  }

  async stat(path: string): Promise<FileStat> {
    const fullPath = this.toFullPath(path);
    const info = await fsStat(fullPath);
    return {
      path: this.toVirtualPath(fullPath),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      kind: info.isDirectory() ? "directory" : "file"
    };
  }

  async read(path: string, range: Range = {}): Promise<ContentChunk> {
    const fullPath = this.toFullPath(path);
    const content = await readFile(fullPath, "utf8");
    const offset = range.offset ?? 0;
    const end = range.length ? offset + range.length : undefined;
    return {
      path: this.toVirtualPath(fullPath),
      content: content.slice(offset, end),
      offset
    };
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const terms = tokenize(query.query);
    const start = this.toFullPath(query.path ?? "/");
    const files = await this.walk(start);
    const results: SearchResult[] = [];

    for (const file of files) {
      let content = "";
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const score = scoreText(content, terms);
      if (score <= 0) continue;
      results.push({
        path: this.toVirtualPath(file),
        snippet: makeSnippet(content, terms),
        score,
        metadata: {
          driver: "local-file-system"
        }
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 10);
  }

  private async walk(path: string): Promise<string[]> {
    const info = await fsStat(path);
    if (info.isFile()) return [path];

    const entries = await readdir(path, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (this.excludes.has(entry.name)) continue;
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walk(fullPath)));
      } else if (entry.isFile() && isTextLike(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private toFullPath(path: string): string {
    const trimmed = path.replace(/^\/+/, "");
    const fullPath = resolve(this.root, trimmed);
    if (fullPath !== this.root && !fullPath.startsWith(`${this.root}\\`) && !fullPath.startsWith(`${this.root}/`)) {
      throw new Error(`Path escapes local mount: ${path}`);
    }
    return fullPath;
  }

  private toVirtualPath(fullPath: string): string {
    const rel = relative(this.root, fullPath).replace(/\\/g, "/");
    return rel ? `/${rel}` : "/";
  }
}

function isTextLike(name: string): boolean {
  return /\.(md|txt|ts|tsx|js|jsx|json|yaml|yml|html|css)$/i.test(name);
}

function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).find((position) => position >= 0) ?? 0;
  const start = Math.max(0, index - 120);
  const end = Math.min(content.length, index + 240);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

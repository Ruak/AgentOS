import type {
  ContentChunk,
  EventHandler,
  FileStat,
  FileSystemDriver,
  KnowledgeFS,
  Range,
  SearchQuery,
  SearchResult
} from "../types.ts";

export class MountedKnowledgeFS implements KnowledgeFS {
  private readonly mounts = new Map<string, FileSystemDriver>();

  mount(path: string, driver: FileSystemDriver): void {
    const normalized = normalizeMount(path);
    if (this.mounts.has(normalized)) {
      throw new Error(`Mount already exists: ${normalized}`);
    }
    this.mounts.set(normalized, driver);
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.resolve(path);
    return resolved.driver.stat(resolved.innerPath);
  }

  async read(path: string, range?: Range): Promise<ContentChunk> {
    const resolved = this.resolve(path);
    const chunk = await resolved.driver.read(resolved.innerPath, range);
    return {
      ...chunk,
      path: `${resolved.mountPath}${chunk.path === "/" ? "" : chunk.path}`
    };
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (query.path) {
      const resolved = this.resolve(query.path);
      const results = await resolved.driver.search({ ...query, path: resolved.innerPath });
      return results.map((result) => ({
        ...result,
        path: `${resolved.mountPath}${result.path === "/" ? "" : result.path}`
      }));
    }

    const allResults = await Promise.all(
      [...this.mounts.entries()].map(async ([mountPath, driver]) => {
        const results = await driver.search(query);
        return results.map((result) => ({
          ...result,
          path: `${mountPath}${result.path === "/" ? "" : result.path}`
        }));
      })
    );
    return allResults
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 10);
  }

  watch(path: string, callback: EventHandler): void {
    const resolved = this.resolve(path);
    if (!resolved.driver.watch) {
      throw new Error(`Driver does not support watch: ${resolved.mountPath}`);
    }
    resolved.driver.watch(resolved.innerPath, callback);
  }

  private resolve(path: string): { mountPath: string; innerPath: string; driver: FileSystemDriver } {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const candidates = [...this.mounts.keys()]
      .filter((mountPath) => normalizedPath === mountPath || normalizedPath.startsWith(`${mountPath}/`))
      .sort((a, b) => b.length - a.length);
    const mountPath = candidates[0];
    if (!mountPath) throw new Error(`No knowledge mount for path: ${path}`);
    const driver = this.mounts.get(mountPath);
    if (!driver) throw new Error(`Missing driver for mount: ${mountPath}`);
    const innerPath = normalizedPath.slice(mountPath.length) || "/";
    return { mountPath, innerPath, driver };
  }
}

function normalizeMount(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

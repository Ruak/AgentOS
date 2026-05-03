import type { ToolHandler, ToolManifest } from "../types.ts";

export type RegisteredTool = {
  manifest: ToolManifest;
  handler: ToolHandler;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(manifest: ToolManifest, handler: ToolHandler): void {
    if (this.tools.has(manifest.name)) {
      throw new Error(`Tool already registered: ${manifest.name}`);
    }
    this.tools.set(manifest.name, { manifest, handler });
  }

  get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  list(): ToolManifest[] {
    return [...this.tools.values()].map((tool) => tool.manifest);
  }

  listForNames(names: string[]): ToolManifest[] {
    const allowed = new Set(names);
    return this.list().filter((manifest) => allowed.has(manifest.name));
  }
}

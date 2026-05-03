import type { MemoryChunk } from "../types.ts";

export class MemoryStore {
  private readonly chunks: MemoryChunk[] = [];

  write(chunk: MemoryChunk): void {
    this.chunks.push(chunk);
  }

  list(): MemoryChunk[] {
    return [...this.chunks];
  }

  search(query: string, limit = 5): MemoryChunk[] {
    const terms = tokenize(query);
    return this.chunks
      .map((chunk) => ({
        chunk,
        score: scoreText(chunk.content, terms)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => ({ ...item.chunk, score: item.score }));
  }
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fa5]+/u)
    .filter(Boolean);
}

export function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

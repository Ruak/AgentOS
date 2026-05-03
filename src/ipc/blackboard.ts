export class Blackboard {
  private readonly state = new Map<string, unknown>();

  set(key: string, value: unknown): void {
    this.state.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.state.entries());
  }
}

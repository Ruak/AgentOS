import type { Task } from "../types.ts";

export class Scheduler {
  private readonly tasks = new Map<string, Task>();

  schedule(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task already scheduled: ${task.id}`);
    }
    this.tasks.set(task.id, task);
  }

  next(): Task | undefined {
    const candidates = [...this.tasks.values()].filter((task) => {
      if (task.status !== "pending") return false;
      return task.dependencies.every((dependency) => this.tasks.get(dependency)?.status === "done");
    });
    return candidates.sort((a, b) => b.priority - a.priority)[0];
  }

  update(id: string, status: Task["status"]): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    task.status = status;
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }
}

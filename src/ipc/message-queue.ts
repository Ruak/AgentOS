import type { AgentMessage } from "../types.ts";

export class MessageQueue {
  private readonly messages: AgentMessage[] = [];

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
    this.messages.sort((a, b) => b.priority - a.priority);
  }

  dequeue(target?: string): AgentMessage | undefined {
    const index = this.messages.findIndex((message) => !target || message.to === target || message.to === "broadcast");
    if (index < 0) return undefined;
    const [message] = this.messages.splice(index, 1);
    return message;
  }

  list(): AgentMessage[] {
    return [...this.messages];
  }
}

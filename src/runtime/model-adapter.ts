import type { ModelRequest, ModelResponse, ToolCall } from "../types.ts";

let toolCallSeq = 0;

export class MockRuntimeAdapter {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const last = request.messages[request.messages.length - 1];
    if (last?.role === "tool") {
      return response(`Completed with tool result from ${last.name ?? "tool"}:\n${last.content}`);
    }

    const user = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const wantsSearch = /search|find|lookup|rag|knowledge|workspace|搜索|查找|检索|知识|文件/.test(user.toLowerCase());
    const searchTool = request.tools.find((tool) => tool.name === "knowledge_search" || tool.name === "knowledge.search");

    if (wantsSearch && searchTool) {
      const call: ToolCall = {
        id: `call_${++toolCallSeq}`,
        name: searchTool.name,
        args: {
          query: user,
          limit: 5
        }
      };
      return {
        content: "Requesting mounted knowledge search.",
        toolCalls: [call],
        usage: usage(request, "Requesting mounted knowledge search.")
      };
    }

    return response(`Mock agent ${request.agent.name} accepted task: ${user}`);
  }
}

function response(content: string): ModelResponse {
  return {
    content,
    usage: {
      inputTokens: 0,
      outputTokens: Math.ceil(content.length / 4)
    }
  };
}

function usage(request: ModelRequest, output: string): ModelResponse["usage"] {
  return {
    inputTokens: Math.ceil(request.messages.map((message) => message.content).join("\n").length / 4),
    outputTokens: Math.ceil(output.length / 4)
  };
}

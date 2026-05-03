import type { ChatMessage, ModelRequest, ModelResponse, ToolCall, ToolManifest } from "../types.ts";
import { env, loadEnv } from "../config/env.ts";

type DeepSeekMessage = {
  role: ChatMessage["role"];
  content: string | null;
  name?: string;
  tool_call_id?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export class DeepSeekRuntimeAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    loadEnv();
    this.apiKey = options.apiKey ?? env("DEEPSEEK_API_KEY");
    this.baseUrl = trimSlash(options.baseUrl ?? env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"));
    this.model = options.model ?? env("DEEPSEEK_MODEL", "deepseek-v4-flash");
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages.map(toDeepSeekMessage),
        tools: request.tools.map(toDeepSeekTool),
        tool_choice: "auto"
      })
    });

    const body = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) {
      throw new Error(`DeepSeek API error ${response.status}: ${JSON.stringify(body)}`);
    }

    const choice = body.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call: any) => ({
          id: String(call.id),
          name: String(call.function?.name),
          args: parseArgs(call.function?.arguments)
        }))
      : [];

    return {
      content: message.content ?? "",
      reasoningContent: typeof message.reasoning_content === "string" ? message.reasoning_content : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: body.usage
        ? {
            inputTokens: body.usage.prompt_tokens ?? 0,
            outputTokens: body.usage.completion_tokens ?? 0
          }
        : undefined
    };
  }
}

function toDeepSeekMessage(message: ChatMessage): DeepSeekMessage {
  const converted: DeepSeekMessage = {
    role: message.role,
    content: message.content
  };
  if (message.name) converted.name = message.name;
  if (message.toolCallId) converted.tool_call_id = message.toolCallId;
  if (message.reasoningContent) converted.reasoning_content = message.reasoningContent;
  if (message.toolCalls?.length) {
    converted.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.args)
      }
    }));
  }
  return converted;
}

function toDeepSeekTool(tool: ToolManifest) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

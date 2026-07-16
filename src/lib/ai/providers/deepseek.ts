import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { type LLMProvider, type GenerationParams, type LLMResponse, type LLMMessage } from "../types";

export class DeepSeekProvider implements LLMProvider {
  id = "deepseek";
  name = "DeepSeek";
  models = ["deepseek-v4-flash", "deepseek-v4-pro"];
  defaultModel = "deepseek-v4-flash";

  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    });
  }

  private toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message) => ({
      role: message.role,
      content: message.content as string & Array<unknown>,
    })) as ChatCompletionMessageParam[];
  }

  private request(params: GenerationParams & { model?: string }, stream = false) {
    const model = params.model ?? this.defaultModel;
    return {
      model,
      messages: this.toOpenAIMessages(params.messages),
      max_tokens: params.maxTokens ?? 2048,
      ...(model === "deepseek-v4-flash" ? { temperature: params.temperature ?? 0.2 } : {}),
      thinking: { type: model === "deepseek-v4-flash" ? "disabled" : "enabled" },
      ...(stream ? { stream: true } : {}),
    };
  }

  async generateResponse(
    params: GenerationParams & { model?: string }
  ): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create(this.request(params) as any);
    const choice = response.choices[0];
    return {
      content: choice.message.content ?? "",
      finishReason: choice.finish_reason ?? "stop",
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamResponse(
    params: GenerationParams & { model?: string }
  ): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create(this.request(params, true) as any);
    for await (const chunk of stream as any) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
}

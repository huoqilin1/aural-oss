import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  type LLMProvider,
  type GenerationParams,
  type LLMResponse,
  type LLMMessage,
} from "../types";

export class DoubaoProvider implements LLMProvider {
  id = "doubao";
  name = "豆包 (火山方舟)";
  // 火山方舟既接受推理接入点 ID(ep-xxx)也接受模型名；链上实际使用的
  // 模型由 DOUBAO_LLM_MODEL 环境变量指定。
  models = ["doubao-1.5-pro-32k", "doubao-1.5-lite-32k", "doubao-seed-1.6"];
  defaultModel = "doubao-1.5-pro-32k";

  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.DOUBAO_LLM_API_KEY ?? "",
      baseURL:
        process.env.DOUBAO_LLM_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.DOUBAO_LLM_API_KEY);
  }

  private toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content as string & Array<unknown>,
    })) as ChatCompletionMessageParam[];
  }

  async generateResponse(
    params: GenerationParams & { model?: string }
  ): Promise<LLMResponse> {
    const model = params.model ?? this.defaultModel;
    const response = await this.client.chat.completions.create({
      model,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    });
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
    const model = params.model ?? this.defaultModel;
    const stream = await this.client.chat.completions.create({
      model,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}

import OpenAI from "openai";
import { zhipuBaseUrl } from "../../relay-llm-route";
import { acquireGlmSlot, withGlmSlot } from "../../../../server/glm-capacity";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {
  type LLMProvider,
  type GenerationParams,
  type LLMResponse,
  type LLMMessage,
} from "../types";

// GLM 4.5/4.6/5.x 支持显式关闭深度思考。出题必须直出 JSON，
// 否则思考通道会耗尽输出预算（与 DeepSeek 出题相同的教训）。
const THINKING_CONTROL_MODELS = /^glm-(4\.[56]|5)/;

export class ZhipuProvider implements LLMProvider {
  id = "zhipu";
  name = "智谱 GLM";
  models = ["glm-4.6", "glm-4.5", "glm-4.5-air", "glm-5.3"];
  defaultModel = "glm-4.6";

  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.ZHIPU_API_KEY ?? "",
      baseURL: zhipuBaseUrl(),
      maxRetries: 0,
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.ZHIPU_API_KEY);
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
    return withGlmSlot(signal => this.generateAdmitted(params, signal));
  }

  private async generateAdmitted(
    params: GenerationParams & { model?: string }, signal: AbortSignal
  ): Promise<LLMResponse> {
    const model = params.model ?? this.defaultModel;
    const request = {
      model,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      ...(params.disableThinking && THINKING_CONTROL_MODELS.test(model)
        ? { thinking: { type: "disabled" } }
        : {}),
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    const response = await this.client.chat.completions.create(request, { signal });
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
    const lease = await acquireGlmSlot();
    try {
    const model = params.model ?? this.defaultModel;
    const stream = await this.client.chat.completions.create({
      model,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stream: true,
    }, { signal: lease.signal });
    for await (const chunk of stream) {
      lease.signal.throwIfAborted();
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
    } finally { await lease.release(); }
  }
}

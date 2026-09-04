import { getProvider } from "./registry";
import type { GenerationParams, LLMProvider, LLMResponse } from "./types";

export interface FallbackGenerationResult extends LLMResponse {
  /** 实际成功的模型名(或方舟接入点 ID)。 */
  model: string;
  /** 实际提供该模型的 provider id。 */
  provider: string;
}

function resolveProvider(model: string): LLMProvider | null {
  // 火山方舟的推理接入点 ID(ep-xxx) 不是模型名，按 provider 解析。
  if (model.startsWith("ep-")) {
    try {
      return getProvider("doubao");
    } catch {
      return null;
    }
  }
  try {
    const provider = getProvider(model);
    if (provider.models.some((m) => m.toLowerCase() === model.toLowerCase())) {
      return provider;
    }
  } catch {
    // 未配置任何 provider 时 getProvider 会抛错，按不可用处理。
  }
  return null;
}

/**
 * 依次尝试链上的模型，任一成功即返回；未配置(缺 key)或无法解析的模型
 * 自动跳过。全部失败时抛出聚合错误，调用方负责最终兜底(如确定性模板题)。
 * 目的：出题/评分等关键链路绝不因为单一模型账户欠费而中断。
 */
export async function generateWithFallback(
  chain: string[],
  params: GenerationParams
): Promise<FallbackGenerationResult> {
  const failures: string[] = [];
  for (const model of chain) {
    const provider = resolveProvider(model);
    if (!provider || (provider.isConfigured && !provider.isConfigured())) {
      continue;
    }
    try {
      const response = await provider.generateResponse({ ...params, model });
      return { ...response, model, provider: provider.id };
    } catch (err) {
      failures.push(
        `${model}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  throw new Error(
    `generateWithFallback: all models failed — ${failures.join(" | ")}`
  );
}

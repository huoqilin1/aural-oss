import { type LLMProvider } from "./types";
import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";
import { KimiProvider } from "./providers/kimi";
import { MinimaxProvider } from "./providers/minimax";
import { DeepSeekProvider } from "./providers/deepseek";

const providers = new Map<string, LLMProvider>();

function registerProvider(provider: LLMProvider) {
  providers.set(provider.id, provider);
}

registerProvider(new DeepSeekProvider());
registerProvider(new OpenAIProvider());
registerProvider(new GeminiProvider());
registerProvider(new KimiProvider());
registerProvider(new MinimaxProvider());

/** Resolve the right provider for a given model name or provider id. */
export function getProvider(idOrModel?: string | null): LLMProvider {
  if (idOrModel) {
    if (providers.has(idOrModel)) return providers.get(idOrModel)!;
    const allProviders = Array.from(providers.values());
    for (const p of allProviders) {
      if (p.models.some((m: string) => m.toLowerCase() === idOrModel.toLowerCase())) {
        return p;
      }
    }
  }
  if (process.env.DEEPSEEK_API_KEY) return providers.get("deepseek")!;
  if (process.env.OPENAI_API_KEY) return providers.get("openai")!;
  if (process.env.GEMINI_API_KEY) return providers.get("gemini")!;
  if (process.env.KIMI_API_KEY) return providers.get("kimi")!;
  if (process.env.MINIMAX_API_KEY) return providers.get("minimax")!;
  throw new Error("No LLM provider configured. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, KIMI_API_KEY, or MINIMAX_API_KEY.");
}

export function listProviders(): LLMProvider[] {
  return Array.from(providers.values());
}

/** Model used for post-interview report generation. */
export const REPORT_MODEL = process.env.DEEPSEEK_API_KEY
  ? "deepseek-chat"
  : process.env.OPENAI_API_KEY
    ? "gpt-4o"
    : process.env.GEMINI_API_KEY
      ? "gemini-3.1-flash-lite"
      : process.env.KIMI_API_KEY
        ? "kimi-k2.5"
        : "MiniMax-M2.1-lightning";

/** Model used for interview question generation and refinement. */
export const GENERATOR_MODEL = process.env.DEEPSEEK_API_KEY
  ? "deepseek-chat"
  : process.env.OPENAI_API_KEY
    ? "gpt-4o-mini"
    : process.env.GEMINI_API_KEY
      ? "gemini-3.1-flash-lite"
      : process.env.KIMI_API_KEY
        ? "moonshot-v1-8k"
        : "MiniMax-M2.1-lightning";

export const PRIMARY_GENERATOR_MODEL = GENERATOR_MODEL;

export const FALLBACK_GENERATOR_MODEL = process.env.KIMI_API_KEY
  ? "moonshot-v1-8k"
  : process.env.MINIMAX_API_KEY
    ? "MiniMax-M2.1-lightning"
    : GENERATOR_MODEL;
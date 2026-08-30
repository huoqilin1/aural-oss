import { config } from "dotenv";

config({ path: ".env.local" });

async function main(): Promise<void> {
  const { assertRelayLlmReady } = await import("./relay-llm");
  try {
    await assertRelayLlmReady({ force: true });
    console.log("Relay LLM readiness probe passed");
  } catch (error) {
    console.error(
      "Relay LLM readiness probe failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}

void main();

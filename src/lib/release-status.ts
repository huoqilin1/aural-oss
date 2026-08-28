import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

export function releaseRevision(): string {
  try {
    return readFileSync(join(process.cwd(), "REVISION"), "utf8").trim() || "development";
  } catch {
    return process.env.AURAL_REVISION?.trim() || "development";
  }
}

export function probeTcpPort(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

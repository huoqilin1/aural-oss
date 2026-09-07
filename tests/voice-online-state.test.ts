import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishVoiceOnline, readVoiceOnline } from "../server/voice-online-state";

test("missing, expired and broken telemetry is unknown; fresh empty means zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "oprun-voice-online-test-"));
  assert.equal((await readVoiceOnline(root, 1000)).count, null);
  await publishVoiceOnline([], root, 1000);
  assert.equal((await readVoiceOnline(root, 2000)).count, 0);
  await publishVoiceOnline(["synthetic-a", "synthetic-a", "synthetic-b"], root, 2000);
  assert.equal((await readVoiceOnline(root, 3000)).count, 2);
  assert.equal((await readVoiceOnline(root, 3000, "synthetic-a")).connected, true);
  assert.equal((await readVoiceOnline(root, 3000, "synthetic-other")).connected, false);
  assert.equal((await readVoiceOnline(root, 48000, "synthetic-a")).connected, null);
  assert.equal((await readVoiceOnline(root, 48000)).count, null);
  const file = (await readdir(root)).find(name => name.endsWith(".json"))!;
  assert.equal((await readFile(join(root, file), "utf8")).includes("synthetic-a"), false);
  await writeFile(join(root, file), "broken");
  assert.equal((await readVoiceOnline(root, 3000)).count, null);
});

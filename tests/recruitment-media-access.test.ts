import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { RecruitmentMediaAccess } from "../src/lib/voice/recruitment-media-access";

function setup(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requests: Array<{ resolve: (stream: MediaStream) => void; reject: (error: Error) => void }> = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve, reject) => requests.push({ resolve, reject })) },
    permissions: { query: async () => ({ state: "granted" }) },
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else Reflect.deleteProperty(globalThis, "navigator"); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const access = new RecruitmentMediaAccess(true);
  t.after(() => access.dispose());
  return { access, requests };
}
function stream() {
  const tracks = ["audio", "video"].map(kind => ({ kind, readyState: "live", stop() { this.readyState = "ended"; } }));
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter(t => t.kind === "audio"), getVideoTracks: () => tracks.filter(t => t.kind === "video") } as unknown as MediaStream;
}

test("first successful old permission wins while replacement still waits; replacement is released", async t => {
  const { access, requests } = setup(t);
  const pending = access.request();
  assert.equal(access.request(), pending);
  t.mock.timers.tick(9000);
  assert.equal(access.getSnapshot(), "waiting");
  await access.recover();
  assert.equal(requests.length, 2);
  const older = stream();
  requests[0].resolve(older);
  assert.equal(await pending, older);
  const later = stream();
  requests[1].resolve(later);
  await Promise.resolve();
  assert.ok(later.getTracks().every(track => track.readyState === "ended"));
  assert.equal(access.getSnapshot(), "ready");
});

test("disposing pending entry rejects its caller and releases native late permission", async t => {
  const { access, requests } = setup(t);
  const pending = access.request();
  access.dispose();
  await assert.rejects(pending, /disposed/);
  const late = stream(); requests[0].resolve(late);
  await Promise.resolve();
  assert.ok(late.getTracks().every(track => track.readyState === "ended"));
  await assert.rejects(access.request(), /disposed/);
});

test("permission rejection does not re-prompt until an external recovery", async t => {
  const { access, requests } = setup(t);
  const pending = access.request();
  requests[0].reject(new DOMException("denied", "NotAllowedError"));
  await assert.rejects(pending, /浏览器尚未允许/);
  await assert.rejects(access.request());
  assert.equal(requests.length, 1);
  assert.equal(await access.recover(), true);
  const retried = access.request();
  const granted = stream(); requests[1].resolve(granted);
  assert.equal(await retried, granted);
  access.dispose();
  assert.ok(granted.getTracks().every(track => track.readyState === "ended"));
});

test("stale rejected request cannot overwrite a successful recovery", async t => {
  const { access, requests } = setup(t);
  const pending = access.request();
  t.mock.timers.tick(9000); await access.recover();
  requests[1].resolve(stream()); await pending;
  requests[0].reject(new DOMException("old failure", "NotAllowedError"));
  await Promise.resolve();
  assert.equal(access.getSnapshot(), "ready");
});

test("permission query finishing after a native grant preserves ready state", async t => {
  const { access, requests } = setup(t);
  const pending = access.request();
  t.mock.timers.tick(9000);
  const recovery = access.recover();
  requests[0].resolve(stream());
  await pending;
  assert.equal(await recovery, false);
  assert.equal(access.getSnapshot(), "ready");
  assert.equal(requests.length, 1);
});

test("incomplete old permission result does not reject a newer pending request", async t => {
  const { access, requests } = setup(t);
  const pending = access.request();
  t.mock.timers.tick(9000); await access.recover();
  const old = stream(); old.getVideoTracks()[0].stop();
  requests[0].resolve(old); await Promise.resolve();
  assert.equal(access.getSnapshot(), "requesting");
  assert.ok(old.getTracks().every(track => track.readyState === "ended"));
  t.mock.timers.tick(9000);
  assert.equal(access.getSnapshot(), "waiting");
  const valid = stream(); requests[1].resolve(valid);
  assert.equal(await pending, valid);
  assert.equal(access.getSnapshot(), "ready");
});

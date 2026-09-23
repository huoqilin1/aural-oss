import assert from "node:assert/strict";
import test from "node:test";

import { handleFeedbackSave, type FeedbackOps } from "@/app/api/voice/feedback/logic";
import { maskNotePii } from "@/lib/voice/feedback";

// ── maskNotePii 单元测试 ────────────────────────────────────────────

test("maskNotePii hides email addresses", () => {
  assert.equal(maskNotePii("联系我 test@example.com 谢谢"), "联系我 *** 谢谢");
});

test("maskNotePii hides CN mobile numbers", () => {
  assert.equal(maskNotePii("可以打 13812345678 找我"), "可以打 *** 找我");
});

test("maskNotePii hides landline with area code", () => {
  assert.equal(maskNotePii("座机 010-88123456 也行"), "座机 *** 也行");
});

test("maskNotePii keeps ordinary text intact", () => {
  assert.equal(
    maskNotePii("整体不错,就是加载有点慢"),
    "整体不错,就是加载有点慢",
  );
});

// ── handleFeedbackSave 核心逻辑测试 ─────────────────────────────────

function createOps(overrides: Partial<FeedbackOps> = {}): FeedbackOps {
  const session = {
    status: "COMPLETED",
    interviewId: "interview-1",
    publicSlug: "public-interview",
    isActive: true,
  };
  return {
    async loadSession() {
      return session;
    },
    async loadLinkedCandidate(inviteToken) {
      return inviteToken === "good-token"
        ? { sessionId: "session-1" }
        : { sessionId: "other-session" };
    },
    async insertFeedback(payload) {
      return { conflict: false };
    },
    ...overrides,
  };
}

const validPayload = {
  sessionId: "session-1",
  inviteToken: "good-token",
  rating: 5,
  tags: ["面试流程顺畅"],
  note: "联系邮箱 a@b.com 人很好",
};

test("invite session with valid token stores masked note", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const result = await handleFeedbackSave(validPayload, createOps({
    async insertFeedback(payload) {
      captured.push({ ...payload });
      return { conflict: false };
    },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.submitted, true);
  const stored = captured[0];
  assert.ok(stored);
  assert.equal(stored.note, "联系邮箱 *** 人很好");
  assert.equal(stored.rating, 5);
});

test("wrong token or mismatched session is forbidden", async () => {
  const result = await handleFeedbackSave(
    { ...validPayload, inviteToken: "bad-token" },
    createOps(),
  );
  assert.equal(result.status, 403);
});

test("session not completed is forbidden", async () => {
  const result = await handleFeedbackSave(validPayload, createOps({
    async loadSession() {
      return {
        status: "IN_PROGRESS",
        interviewId: "interview-1",
        publicSlug: null,
        isActive: true,
      };
    },
  }));
  assert.equal(result.status, 403);
});

test("public walk-in session needs publicSlug and isActive", async () => {
  const pub = await handleFeedbackSave(
    { sessionId: "session-1", rating: 4, tags: [] },
    createOps(),
  );
  assert.equal(pub.status, 200);

  const blocked = await handleFeedbackSave(
    { sessionId: "session-1", rating: 4, tags: [] },
    createOps({
      async loadSession() {
        return {
          status: "COMPLETED",
          interviewId: "interview-1",
          publicSlug: null,
          isActive: true,
        };
      },
    }),
  );
  assert.equal(blocked.status, 403);
});

test("duplicate insert (unique conflict) is idempotent success", async () => {
  const result = await handleFeedbackSave(validPayload, createOps({
    async insertFeedback() {
      return { conflict: true };
    },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, true);
});

test("insert failure returns 500", async () => {
  const result = await handleFeedbackSave(validPayload, createOps({
    async insertFeedback() {
      return null;
    },
  }));
  assert.equal(result.status, 500);
});

test("invalid payload rejected with 400", async () => {
  const bad = await handleFeedbackSave(
    { sessionId: "session-1", rating: 9 },
    createOps(),
  );
  assert.equal(bad.status, 400);
  const missing = await handleFeedbackSave({}, createOps());
  assert.equal(missing.status, 400);
});

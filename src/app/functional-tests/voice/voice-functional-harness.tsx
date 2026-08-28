"use client";

import { VoiceInterface } from "@/components/session/voice-interface";
import { useEffect, useState } from "react";

type FunctionalRelayEvent =
  | { type: "ready"; delay?: number; sessionId?: string }
  | { type: "close"; delay?: number; code?: number; reason?: string }
  | { type: "json"; delay?: number; message: Record<string, unknown> };

type FunctionalScenario = Record<string, { events: FunctionalRelayEvent[] }>;

type FunctionalScenarioId =
  | "default"
  | "english-failover"
  | "chinese-failover"
  | "farewell-complete"
  | "thinking-after-asr"
  | "thinking-until-response"
  | "advance-idempotency"
  | "advance-followup-guard"
  | "recruitment-incomplete"
  | "recruitment-eight-question";

declare global {
  interface Window {
    __functionalRelayConnections?: Array<{ url: string; path: string }>;
    __functionalRelaySentMessages?: Array<Record<string, unknown>>;
    __functionalMediaRequests?: MediaStreamConstraints[];
    __functionalRelayScenario?: FunctionalScenario;
    __functionalScenarioId?: FunctionalScenarioId;
    __functionalRelayMockInstalled?: boolean;
  }
}

const functionalScenarios: Record<FunctionalScenarioId, FunctionalScenario> = {
  default: {
    "/ws/voice": {
      events: [{ type: "ready", delay: 30 }],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "english-failover": {
    "/ws/voice": {
      events: [{ type: "close", delay: 30 }],
    },
    "/ws/openai-voice": {
      events: [{ type: "ready", delay: 30 }],
    },
  },
  "chinese-failover": {
    "/ws/voice": {
      events: [{ type: "close", delay: 30 }],
    },
    "/ws/openai-voice": {
      events: [{ type: "ready", delay: 30 }],
    },
  },
  "farewell-complete": {
    "/ws/voice": {
      events: [
        { type: "ready", delay: 20 },
        {
          type: "json",
          delay: 120,
          message: {
            type: "tts_text",
            data: {
              text: "Understood, we're all set. Thanks for your time today and take care.",
            },
          },
        },
        { type: "json", delay: 180, message: { type: "tts_ended" } },
        { type: "json", delay: 200, message: { type: "interview_complete" } },
      ],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "thinking-after-asr": {
    "/ws/voice": {
      events: [
        { type: "ready", delay: 20 },
        {
          type: "json",
          delay: 100,
          message: {
            type: "asr",
            data: {
              results: [{ text: "I led a reporting dashboard project" }],
            },
          },
        },
        {
          type: "json",
          delay: 220,
          message: {
            type: "asr_ended",
            text: "I led a reporting dashboard project",
          },
        },
      ],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "thinking-until-response": {
    "/ws/voice": {
      events: [
        { type: "ready", delay: 20 },
        {
          type: "json",
          delay: 100,
          message: {
            type: "asr",
            data: {
              results: [{ text: "I led a reporting dashboard project" }],
            },
          },
        },
        {
          type: "json",
          delay: 220,
          message: {
            type: "asr_ended",
            text: "I led a reporting dashboard project",
          },
        },
        { type: "json", delay: 260, message: { type: "response_started" } },
        { type: "json", delay: 320, message: { type: "interrupt" } },
        {
          type: "json",
          delay: 1_000,
          message: {
            type: "tts_text",
            data: {
              text: "Thanks for explaining that project.",
            },
          },
        },
        { type: "json", delay: 1_050, message: { type: "tts_ended" } },
      ],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "advance-idempotency": {
    "/ws/voice": {
      events: [
        { type: "ready", delay: 20 },
        {
          type: "json",
          delay: 100,
          message: {
            type: "asr_ended",
            text: "I owned the delivery and verified the result with production data.",
          },
        },
        { type: "json", delay: 130, message: { type: "response_started" } },
        {
          type: "json",
          delay: 200,
          message: {
            type: "tts_text",
            data: { text: "Thanks, that evidence is clear." },
          },
        },
        { type: "json", delay: 240, message: { type: "tts_ended" } },
      ],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "advance-followup-guard": {
    "/ws/voice": {
      events: [
        { type: "ready", delay: 20 },
        {
          type: "json",
          delay: 100,
          message: {
            type: "asr_ended",
            text: "I owned the delivery and verified the result with production data.",
          },
        },
        { type: "json", delay: 130, message: { type: "response_started" } },
        {
          type: "json",
          delay: 200,
          message: {
            type: "tts_text",
            data: { text: "Could you explain the exact metric and verification method?" },
          },
        },
        { type: "json", delay: 240, message: { type: "tts_ended" } },
      ],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "recruitment-incomplete": {
    "/ws/voice": {
      events: [{ type: "ready", delay: 20 }],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
  "recruitment-eight-question": {
    "/ws/voice": {
      events: [{ type: "ready", delay: 20 }],
    },
    "/ws/openai-voice": {
      events: [{ type: "close", delay: 30 }],
    },
  },
};

function installFunctionalRelayMocks(
  scenario: FunctionalScenario,
  scenarioId: FunctionalScenarioId,
) {
  const normalizePath = (pathname: string) => pathname.replace(/\/+$/, "") || "/";
  const relayPaths = new Set(["/ws/voice", "/ws/openai-voice"]);

  window.__functionalRelayConnections = [];
  window.__functionalRelaySentMessages = [];
  window.__functionalMediaRequests = [];
  window.__functionalRelayScenario = scenario;
  window.__functionalScenarioId = scenarioId;
  window.sessionStorage.setItem("__functionalRelayConnections", "[]");
  window.sessionStorage.setItem("__functionalRelaySentMessages", "[]");
  window.sessionStorage.setItem("__functionalMediaRequests", "[]");

  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
  }
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints) {
      throw new TypeError("Functional getUserMedia requires explicit constraints");
    }
    const requests = [...(window.__functionalMediaRequests ?? []), constraints];
    window.__functionalMediaRequests = requests;
    window.sessionStorage.setItem(
      "__functionalMediaRequests",
      JSON.stringify(requests),
    );
    return new MediaStream();
  };

  if (window.__functionalRelayMockInstalled) {
    return;
  }

  const realWebSocket = window.WebSocket;

  class MockRelaySocket {
    readonly url: string;
    readonly path: string;
    readonly events: FunctionalRelayEvent[];
    readyState = 0;
    binaryType = "arraybuffer";
    onopen: ((event?: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onclose: ((event?: unknown) => void) | null = null;
    private scheduled = false;
    private currentQuestionIndex = 0;

    constructor(url: string | URL) {
      this.url = String(url);
      this.path = normalizePath(new URL(this.url, window.location.href).pathname);
      this.events = window.__functionalRelayScenario?.[this.path]?.events ?? [];

      const nextConnections = [
        ...(window.__functionalRelayConnections ?? []),
        { url: this.url, path: this.path },
      ];
      window.__functionalRelayConnections = nextConnections;
      window.sessionStorage.setItem(
        "__functionalRelayConnections",
        JSON.stringify(nextConnections),
      );

      setTimeout(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }

    send(data: string): void {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (parsed) {
        const sentMessages = [
          ...(window.__functionalRelaySentMessages ?? []),
          parsed,
        ];
        window.__functionalRelaySentMessages = sentMessages;
        window.sessionStorage.setItem(
          "__functionalRelaySentMessages",
          JSON.stringify(sentMessages),
        );
      }

      if (
        parsed?.type === "text_input"
        && window.__functionalScenarioId === "recruitment-eight-question"
      ) {
        const finalQuestion = this.currentQuestionIndex === 7;
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: "response_started" }),
          });
        }, 20);
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "tts_text",
              data: {
                text: finalQuestion
                  ? "Understood, we're all set. Thanks for your time today and take care."
                  : "Thanks, that evidence is clear.",
              },
            }),
          });
        }, 60);
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ type: "tts_ended" }) });
        }, 100);
        if (finalQuestion) {
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({ type: "interview_complete" }),
            });
          }, 140);
        }
      }

      if (parsed?.type === "next_question") {
        const recruitmentFlow =
          window.__functionalScenarioId === "recruitment-eight-question";
        const nextIndex = recruitmentFlow
          ? Math.min(this.currentQuestionIndex + 1, 7)
          : 1;
        this.currentQuestionIndex = nextIndex;
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: "transitioning", direction: "next" }),
          });
        }, 20);
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "question_change",
              questionIndex: nextIndex,
              totalQuestions: recruitmentFlow ? 8 : 2,
              requestId: parsed?.requestId,
            }),
          });
        }, 120);
      }

      if (parsed?.type === "init" && !this.scheduled) {
        this.scheduled = true;
        for (const event of this.events) {
          setTimeout(() => {
            if (this.readyState === 3) return;

            if (event.type === "ready") {
              this.onmessage?.({
                data: JSON.stringify({
                  type: "ready",
                  sessionId: event.sessionId ?? "functional-session",
                }),
              });
              return;
            }

            if (event.type === "json") {
              this.onmessage?.({
                data: JSON.stringify(event.message),
              });
              return;
            }

            if (event.type === "close") {
              this.readyState = 3;
              this.onclose?.({
                code: event.code ?? 1006,
                reason: event.reason ?? "functional close",
              });
            }
          }, event.delay ?? 0);
        }
      }
    }

    close(code?: number, reason?: string): void {
      this.readyState = 3;
      this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
    }
  }

  window.WebSocket = function functionalWebSocket(url: string | URL, protocols?: string | string[]) {
    const resolved = new URL(String(url), window.location.href);
    const path = normalizePath(resolved.pathname);
    if (relayPaths.has(path)) {
      return new MockRelaySocket(resolved.toString()) as unknown as WebSocket;
    }
    return new realWebSocket(url, protocols);
  } as unknown as typeof WebSocket;

  window.WebSocket.prototype = realWebSocket.prototype;
  window.__functionalRelayMockInstalled = true;
}

export function VoiceFunctionalHarness({
  language,
  scenario,
}: {
  language: string;
  scenario: string;
}) {
  const [parentCompleted, setParentCompleted] = useState(false);
  const [mocksReady, setMocksReady] = useState(false);
  const isRecruitmentScenario = scenario.startsWith("recruitment-");
  const isAdvanceScenario = scenario.startsWith("advance-") || isRecruitmentScenario;
  const recruitmentQuestions = [
    "请结合你的真实经历做自我介绍。",
    "请说明一项与岗位核心职责最相关的经历。",
    "请说明你本人在该经历中负责的具体部分。",
    "请拆解一次复杂问题的定位和解决过程。",
    "请展示一个能够核验能力的工作样例。",
    "请说明结果数据的口径、时间窗口和验证方法。",
    "请说明一次协作分歧以及你如何处理。",
    "请说明求职动机、岗位预期和稳定性。",
  ].map((text, order) => ({
    text,
    type: "OPEN_ENDED",
    description: "Recruitment functional test prompt",
    order,
  }));
  const functionalQuestions = isRecruitmentScenario
    ? recruitmentQuestions
    : isAdvanceScenario
    ? [
        {
          text: "Tell me about a project you are proud of.",
          type: "OPEN_ENDED",
          description: "Functional test prompt",
          order: 0,
        },
        {
          text: "Explain a difficult decision you made in that project.",
          type: "OPEN_ENDED",
          description: "Functional test prompt",
          order: 1,
        },
      ]
    : [
        {
          text: "Tell me about a project you are proud of.",
          type: "OPEN_ENDED",
          description: "Functional test prompt",
          order: 0,
        },
      ];

  useEffect(() => {
    const activeScenario =
      functionalScenarios[scenario as FunctionalScenarioId] ??
      functionalScenarios.default;
    installFunctionalRelayMocks(
      activeScenario,
      scenario as FunctionalScenarioId,
    );
    setMocksReady(true);
  }, [scenario]);

  return (
    <div className="relative min-h-screen bg-background">
      <div
        data-testid="parent-complete"
        className="sr-only"
        aria-live="polite"
      >
        {parentCompleted ? "true" : "false"}
      </div>
      <div data-testid="harness-language" className="sr-only">
        {language}
      </div>
      <div data-testid="harness-ready" className="sr-only">
        {mocksReady ? "true" : "false"}
      </div>
      {mocksReady && (
        <VoiceInterface
          sessionId="functional-session"
          interviewId="functional-interview"
          interviewTitle={isAdvanceScenario ? "数君招聘 · Functional Voice Interview" : "Functional Voice Interview"}
          aiName="TestInterviewer"
          questionCount={functionalQuestions.length}
          durationMinutes={15}
          interviewContext={{
            title: isAdvanceScenario ? "数君招聘 · Functional Voice Interview" : "Functional Voice Interview",
            objective: "Exercise the core voice interview flow in browser tests.",
            aiName: "TestInterviewer",
            aiTone: "Professional",
            language,
            followUpDepth: "Moderate",
            questions: functionalQuestions,
          }}
          chatEnabled={isRecruitmentScenario}
          videoMode={isAdvanceScenario}
          autoStart={isAdvanceScenario}
          onComplete={() => setParentCompleted(true)}
        />
      )}
    </div>
  );
}

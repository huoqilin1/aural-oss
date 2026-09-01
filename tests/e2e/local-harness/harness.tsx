// 本地验收入口(仅 local,不代表生产):渲染真实 VoiceInterface/useVoice,
// 连接本地协议忠实 mock-relay(见 mock-relay.mjs)。
import { createRoot } from "react-dom/client";
import { VoiceInterface } from "@/components/session/voice-interface";

const DIMENSIONS = [
  "core_experience", "project_ownership", "core_skill_evidence",
  "result_authenticity", "job_work_sample", "problem_solving",
  "ai_learning_boundary", "collaboration_motivation_stability",
];
const QUESTIONS = DIMENSIONS.map((dimension, index) => ({
  id: `local-q-${index}`,
  order: index,
  text: `第 ${index + 1} 道面试题(${dimension})。`,
  type: "OPEN_ENDED",
  description: `oprun_dimension:${dimension}`,
}));

function Harness() {
  return (
    <div style={{ position: "relative", minHeight: "100vh", background: "#f5f5f0" }}>
      <div data-testid="harness-status" style={{ position: "fixed", inset: "0 0 auto 0", zIndex: 9999, background: "#fff", padding: 4, fontSize: 12, fontFamily: "monospace" }} aria-live="polite">
        harness ready
      </div>
      <VoiceInterface
        sessionId="local-acceptance-session"
        interviewId="local-acceptance-interview"
        interviewTitle="数君招聘 · 本地验收"
        aiName="小君"
        durationMinutes={30}
        interviewContext={{
          title: "数君招聘 · 本地验收",
          sessionId: "local-acceptance-session",
          interviewId: "local-acceptance-interview",
          objective: "本地验收:打字消息到达中继、终态拒绝不重连。",
          aiName: "小君",
          aiTone: "professional",
          language: "zh-CN",
          followUpDepth: "moderate",
          questions: QUESTIONS,
        }}
        chatEnabled
        videoMode={false}
        autoStart
        onComplete={() => {
          const el = document.querySelector('[data-testid="harness-status"]');
          if (el) el.textContent = "harness completed";
        }}
      />
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Harness />);

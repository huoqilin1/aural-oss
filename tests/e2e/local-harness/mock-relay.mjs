// 协议忠实的中继模拟器(仅本地验收):测试端走真实前端 use-voice + VoiceInterface,
// 中继按真实协议子集应答(init/ready/tts_text/二进制音频/tts_ended/input_ready/
// question_change/text_input/interview_incomplete)。不连任何外部服务。
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_RELAY_PORT || 8767);
const SCENARIO = process.env.MOCK_RELAY_SCENARIO || "greeting_chat_terminal";

// 24kHz int16 PCM,0.3 秒静音帧(足以驱动真实播放器进入 isSpeaking)
function silenceFrame(ms = 300, sampleRate = 24000) {
  const samples = Math.floor((ms / 1000) * sampleRate);
  return new Int16Array(samples);
}

function log(...args) {
  console.log("[mock-relay]", ...args);
}

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
wss.on("connection", (ws) => {
  const received = { text_input: [], init: null };
  let initAt = 0;
  const sendJson = (obj) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  };
  const sendSilence = (totalMs) => {
    const step = 300;
    for (let t = 0; t < totalMs; t += step) {
      const frame = silenceFrame(Math.min(step, totalMs - t));
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(frame.buffer);
    }
  };

ws.on("message", (raw, isBinary) => {
  if (isBinary) return;
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.type === "init") {
    received.init = (received.init || 0) + 1;
    initAt = Date.now();
    const context = msg.context || {};
    log(`init #${received.init}: interview=${context.interviewId} session=${context.sessionId} q=${context.startQuestionIndex}`);
      sendJson({ type: "ready", sessionId: context.sessionId || "mock-session-1" });
      sendJson({ type: "question_count_update", totalQuestions: context.questions?.length || 8 });

      if (SCENARIO === "greeting_chat_terminal") {
        // 1) AI 问候 TTS(前端处于 isSpeaking/isInputReady=false 状态,约 4s)
        sendJson({ type: "tts_text", data: { text: "您好，欢迎参加本次面试，我们开始吧。" } });
        sendSilence(4000);
        sendJson({ type: "tts_ended" });
        // 2) 输入就绪 + 进入第 1 题
        sendJson({ type: "input_ready" });
        sendJson({ type: "question_change", questionIndex: 0, totalQuestions: context.questions?.length || 8, auto: false });
      } else if (SCENARIO === "q1_answer_then_terminal") {
        // 直接进入第 1 题
        sendJson({ type: "question_change", questionIndex: 0, totalQuestions: context.questions?.length || 8, auto: false });
        sendJson({ type: "input_ready" });
      } else {
        sendJson({ type: "error", message: `unknown scenario ${SCENARIO}` });
      }
      return;
    }

    if (msg.type === "text_input") {
      received.text_input.push(msg);
      const elapsed = initAt ? Date.now() - initAt : -1;
      const during = initAt && elapsed < 4000 ? " [during-greeting-TTS]" : "";
      log(`text_input received (${received.text_input.length}) @${elapsed}ms: ${String(msg.content || "").slice(0, 40)}${during}`);
      // 回执:即使还在 TTS 播放中也立即应答(真实中继以 chat/tts_text 流式回应)
      sendJson({ type: "chat", data: { text: "收到您发送的内容。", source: "chat" } });
      if (SCENARIO === "greeting_chat_terminal" && received.text_input.length >= 2) {
        // 第三个场景:服务端终态拒绝(会话已结束)
        sendJson({
          type: "interview_incomplete",
          reason: "session_terminal",
          message: "该场面试已结束，请查看结果或联系招聘负责人重新安排。",
        });
        ws.close(1013, "session_terminal");
      }
    }
  });

  ws.on("close", () => {
    log(`closed; text_input count=${received.text_input.length} duration=${initAt ? Date.now() - initAt : 0}ms`);
  });
});

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("mock relay is websocket-only");
}).listen(PORT + 1, () => {
  log(`health http on 127.0.0.1:${PORT + 1}`);
});

process.on("SIGINT", () => {
  wss.close();
  server.close();
  process.exit(0);
});
log(`listening on ws://127.0.0.1:${PORT} scenario=${SCENARIO}`);

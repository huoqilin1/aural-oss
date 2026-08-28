// 服务端会话收尾的纯判定逻辑。抽成独立模块以便单测——voice-relay.ts
// 一被 import 就会启动 WebSocket 服务,不能直接进测试进程。

export interface LiveSessionRecord {
  sessionId: string;
  /** 锚定 sessions.startedAt(重连不重置),取不到时退回连接时刻 */
  startedAtMs: number;
  lastActiveAtMs: number;
  timeLimitMinutes: number | null;
  isRecruitmentInterview: boolean;
  status: "live" | "ended";
}

export type SessionFinalizationPlan = {
  status: "COMPLETED" | "ABANDONED";
  reason: string;
};

/**
 * 三条兜底:
 * 1. 普通面试硬限:超 timeLimitMinutes+60s 强制 COMPLETED。数君招聘例外:
 *    活跃回答时没有业务硬限,必须完成八道题;
 * 2. 断线:无任何消息超过宽限期(候选人关页/划走)判 ABANDONED;
 * 3. 已结束的记录不再处理。
 * 优先级:硬限 > 断线(挂着不说话超硬限也该按时结束)。
 */
export function planSessionFinalization(
  record: LiveSessionRecord,
  nowMs: number,
  disconnectGraceMs: number,
): SessionFinalizationPlan | null {
  if (record.status === "ended") return null;
  const hardLimitMs =
    !record.isRecruitmentInterview
      && record.timeLimitMinutes && record.timeLimitMinutes > 0
      ? record.timeLimitMinutes * 60_000 + 60_000
      : 0;
  if (hardLimitMs && nowMs - record.startedAtMs >= hardLimitMs) {
    return { status: "COMPLETED", reason: "server_time_limit" };
  }
  if (nowMs - record.lastActiveAtMs >= disconnectGraceMs) {
    return { status: "ABANDONED", reason: "candidate_disconnected" };
  }
  return null;
}

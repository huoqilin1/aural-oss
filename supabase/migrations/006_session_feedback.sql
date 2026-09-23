-- 006: Session feedback survey (anonymous)
-- 参加者在面试完成页留下的匿名反馈,用于 HR 看板统计(均分/标签/词云),
-- 只存会话关联字段与评分,不存姓名、邮箱、电话等个人信息。
-- 每场面试只允许一条反馈,重复提交由 UNIQUE("sessionId") 拒绝(idempotent 视为已提交)。
-- 写入仅通过 service-role 的 /api/voice/feedback 路由(RLS 不开放 anon 策略)。

CREATE TABLE session_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sessionId"  uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  rating       int NOT NULL CHECK (rating >= 1 AND rating <= 5),
  tags         text[] NOT NULL DEFAULT '{}',
  note         text,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE session_feedback ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_session_feedback_created_at ON session_feedback ("createdAt");

CREATE TRIGGER set_updated_at BEFORE UPDATE ON session_feedback
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

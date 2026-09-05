-- Recruitment transcript completion is serialized with all message inserts.
-- Deploy this migration before the matching application. It does not change scores.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS "voiceRevision" bigint NOT NULL DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS "completedVoiceRevision" bigint;

CREATE OR REPLACE FUNCTION public.guard_recruit_voice_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE session_status text; interview_title text; interview_id uuid;
BEGIN
  SELECT s.status::text, i.title, i.id INTO session_status, interview_title, interview_id
  FROM public.sessions s JOIN public.interviews i ON i.id = s."interviewId"
  WHERE s.id = NEW."sessionId" FOR UPDATE OF s;
  IF interview_title !~ '^数君招聘\s*·\s*' OR interview_title IS NULL THEN RETURN NEW; END IF;
  -- A lost acknowledgement may be replayed after completion. The storage
  -- adapter still checks that the immutable row exactly matches the payload.
  IF EXISTS (SELECT 1 FROM public.messages WHERE id = NEW.id) THEN RETURN NEW; END IF;
  IF NEW."questionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.questions q WHERE q.id = NEW."questionId" AND q."interviewId" = interview_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PVR04', MESSAGE = 'Question does not belong to this recruitment interview';
  END IF;
  IF session_status = 'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE = 'PVR02', MESSAGE = 'Recruitment transcript is already closed';
  END IF;
  UPDATE public.sessions SET "voiceRevision" = "voiceRevision" + 1 WHERE id = NEW."sessionId";
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_recruit_voice_completion()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE interview_title text; required_count integer; answered_count integer;
BEGIN
  IF NEW.status::text <> 'COMPLETED' OR OLD.status::text = 'COMPLETED' THEN RETURN NEW; END IF;
  SELECT title INTO interview_title FROM public.interviews WHERE id = NEW."interviewId";
  IF interview_title !~ '^数君招聘\s*·\s*' OR interview_title IS NULL THEN RETURN NEW; END IF;
  IF NEW."completedVoiceRevision" IS NULL OR NEW."completedVoiceRevision" <> OLD."voiceRevision" THEN
    RAISE EXCEPTION USING ERRCODE = 'PVR01', MESSAGE = 'Transcript changed before completion';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM public.messages m WHERE m."sessionId" = NEW.id
    AND m."questionId" = q.id AND m.role::text = 'USER' AND length(btrim(m.content)) > 0
  )) INTO required_count, answered_count FROM public.questions q
  WHERE q."interviewId" = NEW."interviewId"
  AND q.description ~ '^oprun_dimension:(?!candidate_closing)';
  IF required_count <> 8 OR answered_count <> 8 THEN
    RAISE EXCEPTION USING ERRCODE = 'PVR03', MESSAGE = 'Eight scored answers must be stored before completion';
  END IF;
  RETURN NEW;
END $$;

-- Whiteboard/code edits also contribute to the report. Serialize edits and
-- deletes, while allowing the established whole-session deletion cascade.
CREATE OR REPLACE FUNCTION public.guard_recruit_voice_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE session_status text; interview_title text; interview_id uuid;
BEGIN
  SELECT s.status::text, i.title, i.id INTO session_status, interview_title, interview_id
  FROM public.sessions s JOIN public.interviews i ON i.id = s."interviewId"
  WHERE s.id = OLD."sessionId" FOR UPDATE OF s;
  IF TG_OP = 'UPDATE' AND NEW."sessionId" IS DISTINCT FROM OLD."sessionId" THEN
    IF interview_title ~ '^数君招聘\s*·\s*' OR EXISTS (
      SELECT 1 FROM public.sessions s JOIN public.interviews i ON i.id = s."interviewId"
      WHERE s.id = NEW."sessionId" AND i.title ~ '^数君招聘\s*·\s*'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'PVR04', MESSAGE = 'Recruitment evidence cannot move to another session';
    END IF;
  END IF;
  IF interview_title ~ '^数君招聘\s*·\s*' THEN
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW."questionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.questions q WHERE q.id = NEW."questionId" AND q."interviewId" = interview_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'PVR04', MESSAGE = 'Question does not belong to this recruitment interview';
    END IF;
    IF session_status = 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = 'PVR02', MESSAGE = 'Recruitment transcript is already closed';
    END IF;
    UPDATE public.sessions SET "voiceRevision" = "voiceRevision" + 1 WHERE id = OLD."sessionId";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recruit_voice_insert_guard ON public.messages;
CREATE TRIGGER recruit_voice_insert_guard BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.guard_recruit_voice_insert();
DROP TRIGGER IF EXISTS recruit_voice_completion_guard ON public.sessions;
CREATE TRIGGER recruit_voice_completion_guard BEFORE UPDATE OF status ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_recruit_voice_completion();
DROP TRIGGER IF EXISTS recruit_voice_change_guard ON public.messages;
CREATE TRIGGER recruit_voice_change_guard BEFORE UPDATE OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.guard_recruit_voice_change();

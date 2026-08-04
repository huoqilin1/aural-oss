-- Recruiting integration reliability and idempotency.

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS "externalCorrelationId" text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interviews_external_correlation
  ON interviews ("externalCorrelationId")
  WHERE "externalCorrelationId" IS NOT NULL;

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS "externalCorrelationId" text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_interview_external_correlation
  ON candidates ("interviewId", "externalCorrelationId")
  WHERE "externalCorrelationId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS recruit_question_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "interviewId" uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  version text NOT NULL,
  "idempotencyKey" text,
  status text NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  "questionCount" int NOT NULL DEFAULT 0,
  error text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("interviewId", version)
);

CREATE INDEX IF NOT EXISTS idx_recruit_question_runs_interview
  ON recruit_question_generation_runs ("interviewId", "updatedAt" DESC);

ALTER TABLE recruit_question_generation_runs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION claim_recruit_question_generation(
  p_interview_id uuid,
  p_version text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run recruit_question_generation_runs;
  v_inserted_count int := 0;
BEGIN
  INSERT INTO recruit_question_generation_runs (
    "interviewId", version, "idempotencyKey", status
  )
  VALUES (p_interview_id, p_version, p_idempotency_key, 'PROCESSING')
  ON CONFLICT ("interviewId", version) DO NOTHING;
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  SELECT * INTO v_run
  FROM recruit_question_generation_runs
  WHERE "interviewId" = p_interview_id AND version = p_version
  FOR UPDATE;

  IF v_run.status = 'FAILED' THEN
    UPDATE recruit_question_generation_runs
    SET status = 'PROCESSING', error = NULL, "idempotencyKey" = p_idempotency_key,
        "updatedAt" = now()
    WHERE id = v_run.id
    RETURNING * INTO v_run;
    RETURN json_build_object('claimed', true, 'status', v_run.status,
      'count', v_run."questionCount");
  END IF;

  IF v_run.status = 'PROCESSING'
     AND v_inserted_count = 0
     AND v_run."updatedAt" < now() - interval '15 minutes' THEN
    UPDATE recruit_question_generation_runs
    SET "idempotencyKey" = p_idempotency_key, error = NULL, "updatedAt" = now()
    WHERE id = v_run.id
    RETURNING * INTO v_run;
    RETURN json_build_object('claimed', true, 'status', v_run.status,
      'count', v_run."questionCount", 'recovered', true);
  END IF;

  RETURN json_build_object(
    'claimed', v_inserted_count = 1,
    'status', v_run.status,
    'count', v_run."questionCount"
  );
END;
$$;

CREATE OR REPLACE FUNCTION complete_recruit_question_generation(
  p_interview_id uuid,
  p_version text,
  p_questions jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM sessions
    WHERE "interviewId" = p_interview_id
      AND status IN ('IN_PROGRESS', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'Cannot replace questions after a session has started';
  END IF;

  DELETE FROM questions WHERE "interviewId" = p_interview_id;

  INSERT INTO questions (
    "interviewId", "order", text, type, "isRequired", options, "probeOnShort"
  )
  SELECT
    p_interview_id,
    (item->>'order')::int,
    item->>'text',
    COALESCE((item->>'type')::"QuestionType", 'OPEN_ENDED'::"QuestionType"),
    COALESCE((item->>'isRequired')::boolean, true),
    item->'options',
    COALESCE((item->>'probeOnShort')::boolean, true)
  FROM jsonb_array_elements(p_questions) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE recruit_question_generation_runs
  SET status = 'COMPLETED', "questionCount" = v_count, error = NULL,
      "updatedAt" = now()
  WHERE "interviewId" = p_interview_id AND version = p_version;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION fail_recruit_question_generation(
  p_interview_id uuid,
  p_version text,
  p_error text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE recruit_question_generation_runs
  SET status = 'FAILED', error = left(p_error, 1000), "updatedAt" = now()
  WHERE "interviewId" = p_interview_id AND version = p_version;
$$;

REVOKE ALL ON FUNCTION claim_recruit_question_generation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION complete_recruit_question_generation(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fail_recruit_question_generation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION claim_recruit_question_generation(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION complete_recruit_question_generation(uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION fail_recruit_question_generation(uuid, text, text)
  TO service_role;

-- Independent database boundary mitigation; see docs/RECRUITMENT_ACCESS_RELEASE.md.
-- This does not repair existing server API or relay authorization by itself.
-- Existing public practice RLS behavior is preserved.
-- Shared private media buckets require server-issued signed access for all users.
BEGIN;

CREATE OR REPLACE FUNCTION public.is_recruitment_interview(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$ SELECT COALESCE((SELECT title ~ '^数君招聘\s*·\s*' FROM public.interviews WHERE id=p_id),true) $$;

CREATE OR REPLACE FUNCTION public.is_recruitment_session(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$ SELECT COALESCE((SELECT public.is_recruitment_interview("interviewId") FROM public.sessions WHERE id=p_id),true) $$;

REVOKE ALL ON FUNCTION public.is_recruitment_interview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_recruitment_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_recruitment_interview(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_recruitment_session(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS recruitment_server_access ON public.interviews;
CREATE POLICY recruitment_server_access ON public.interviews AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (title !~ '^数君招聘\s*·\s*') WITH CHECK (title !~ '^数君招聘\s*·\s*');

DROP POLICY IF EXISTS recruitment_server_access ON public.questions;
CREATE POLICY recruitment_server_access ON public.questions AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (NOT public.is_recruitment_interview("interviewId")) WITH CHECK (NOT public.is_recruitment_interview("interviewId"));

DROP POLICY IF EXISTS recruitment_server_access ON public.sessions;
CREATE POLICY recruitment_server_access ON public.sessions AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (NOT public.is_recruitment_interview("interviewId")) WITH CHECK (NOT public.is_recruitment_interview("interviewId"));

DROP POLICY IF EXISTS recruitment_server_access ON public.candidates;
CREATE POLICY recruitment_server_access ON public.candidates AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (NOT public.is_recruitment_interview("interviewId")) WITH CHECK (NOT public.is_recruitment_interview("interviewId"));

DROP POLICY IF EXISTS recruitment_server_access ON public.messages;
CREATE POLICY recruitment_server_access ON public.messages AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (NOT public.is_recruitment_session("sessionId")) WITH CHECK (NOT public.is_recruitment_session("sessionId"));

-- The application already invokes both functions through its service client.
-- Otherwise their SECURITY DEFINER behavior bypasses the row restrictions.
REVOKE EXECUTE ON FUNCTION public.create_interview_session(uuid,text,text,public."InterviewMode",uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.create_invite_session(text,public."InterviewMode",uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_interview_session(uuid,text,text,public."InterviewMode",uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_invite_session(text,public."InterviewMode",uuid) TO service_role;

-- A logged-in account alone is not authorization to list every private recording.
-- The current UI uploads through the server and receives signed viewing URLs.
DROP POLICY IF EXISTS private_interview_media_server_access ON storage.objects;
CREATE POLICY private_interview_media_server_access ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (bucket_id NOT IN ('recordings','screenshots','whiteboards'))
WITH CHECK (bucket_id NOT IN ('recordings','screenshots','whiteboards'));

COMMIT;

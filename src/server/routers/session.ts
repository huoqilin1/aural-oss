import { createLogger } from "@/lib/logger";
import { requireVoiceStorageResult } from "@/app/api/voice/save/logic";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {assertSessionAccess} from '../session-access';
import {SessionAccessError} from '@/lib/voice/session-access';
import { filterAccessibleProjectIds, hasProjectAccess, protectedProcedure, publicProcedure, router } from "../trpc";

const log = createLogger("router/session");

function checkedSessionProcedure(write:boolean) {
  return publicProcedure.use(async ({ctx,rawInput,next}) => {
    const input=rawInput as {id?:unknown;sessionId?:unknown}|null;
    try {await assertSessionAccess(ctx,input?.sessionId ?? input?.id,write);}
    catch(error) {
      if(error instanceof SessionAccessError)throw new TRPCError({
        code:error.status===403?'FORBIDDEN':error.status===404?'NOT_FOUND':error.status===400?'BAD_REQUEST':'INTERNAL_SERVER_ERROR',
        message:error.message,
      });
      throw error;
    }
    return next();
  });
}
const sessionReadProcedure=checkedSessionProcedure(false);
const sessionWriteProcedure=checkedSessionProcedure(true);

export const sessionRouter = router({
  create: publicProcedure
    .input(
      z.object({
        interviewSlug: z.string(),
        participantName: z.string().optional(),
        participantEmail: z.string().email().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: interview } = await ctx.supabase
        .from("interviews")
        .select("*, questions(*)")
        .eq("publicSlug", input.interviewSlug)
        .eq("isActive", true)
        .order("order", { referencedTable: "questions", ascending: true })
        .single();

      if (!interview) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Interview not found or inactive",
        });
      }

      // Enforce invite-only access via candidates table
      if (/^数君招聘\s*·\s*/.test(String(interview.title ?? ''))) {
        throw new TRPCError({code:'FORBIDDEN',message:'请使用本场面试的原邀请链接进入'});
      }
      if (interview.requireInvite) {
        const email = input.participantEmail?.trim().toLowerCase();
        if (!email) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Email is required for invite-only interviews.",
          });
        }
        const { data: candidate } = await ctx.supabase
          .from("candidates")
          .select("id")
          .eq("interviewId", interview.id)
          .eq("email", email)
          .single();

        if (!candidate) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Your email is not on the invite list for this interview.",
          });
        }
      }

      const questions = (interview.questions ?? []) as { id: string }[];

      const derivedMode = interview.voiceEnabled ? "VOICE" : "CHAT";

      const { data: sessionJson, error } = await ctx.supabase.rpc(
        "create_interview_session",
        {
          p_interview_id: interview.id,
          p_participant_name: input.participantName ?? null,
          p_participant_email: input.participantEmail ?? null,
          p_mode_used: derivedMode,
          p_current_question_id: questions[0]?.id ?? null,
        },
      );

      if (error) {
        log.error("RPC error (create):", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }

      const session = sessionJson as { id: string };

      return { sessionId: session.id, interview };
    }),

  createPreview: protectedProcedure
    .input(z.object({ interviewId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { data: interviewAccess } = await ctx.supabase
        .from("interviews")
        .select("id, projectId, project:projects!inner(organizationId)")
        .eq("id", input.interviewId)
        .single();

      if (!interviewAccess) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
      }

      const project = interviewAccess.project as unknown as { organizationId: string };
      const { data: membership } = await ctx.supabase
        .from("organization_members")
        .select("role")
        .eq("workspaceId", project.organizationId)
        .eq("userId", ctx.user.id)
        .single();

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of this organization",
        });
      }

      const projAccess = await hasProjectAccess(
        ctx.supabase,
        interviewAccess.projectId,
        ctx.user.id,
      );
      if (!projAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this project",
        });
      }

      const { data: interview } = await ctx.supabase
        .from("interviews")
        .select("*, questions(*)")
        .eq("id", input.interviewId)
        .order("order", { referencedTable: "questions", ascending: true })
        .single();

      if (!interview) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
      }

      const { data: profile } = await ctx.supabase
        .from("profiles")
        .select("name, email")
        .eq("id", ctx.user.id)
        .single();

      const questions = (interview.questions ?? []) as { id: string }[];
      const derivedMode = interview.voiceEnabled ? "VOICE" : "CHAT";

      const { data: sessionJson, error } = await ctx.supabase.rpc(
        "create_interview_session",
        {
          p_interview_id: interview.id,
          p_participant_name: profile?.name ?? "Preview User",
          p_participant_email: profile?.email ?? ctx.user.email ?? null,
          p_mode_used: derivedMode,
          p_current_question_id: questions[0]?.id ?? null,
        },
      );

      if (error) {
        log.error("RPC error (createPreview):", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }

      const session = sessionJson as { id: string };
      return { sessionId: session.id };
    }),

  createFromInvite: publicProcedure
    .input(z.object({ inviteToken: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Look up candidate + interview via the RPC
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("*, interview:interviews(*, questions(*))")
        .eq("inviteToken", input.inviteToken)
        .single();

      if (!candidate) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid invite link" });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interview = candidate.interview as any;
      if (!interview) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Interview is no longer available" });
      }

      // If session already exists, return it
      if (candidate.sessionId) {
        const { data: existingSession } = await ctx.supabase
          .from("sessions")
          .select("*")
          .eq("id", candidate.sessionId)
          .single();

        if (existingSession) {
          return { sessionId: existingSession.id, interview, isExisting: true };
        }
      }

      // Sort questions
      const questions = (interview.questions ?? []) as { id: string; order: number }[];
      questions.sort((a, b) => a.order - b.order);

      // Create session via RPC (also links it to the candidate)
      const derivedMode = interview.voiceEnabled ? "VOICE" : "CHAT";

      const { data: sessionJson, error } = await ctx.supabase.rpc(
        "create_invite_session",
        {
          p_invite_token: input.inviteToken,
          p_mode_used: derivedMode,
          p_current_question_id: questions[0]?.id ?? null,
        },
      );

      if (error) {
        log.error("RPC error (createFromInvite):", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }

      const session = sessionJson as { id: string };
      return { sessionId: session.id, interview, isExisting: false };
    }),

  getById: sessionReadProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select(
          "*, interview:interviews!inner(*, questions(*)), messages(*)",
        )
        .eq("id", input.id)
        .order("order", {
          referencedTable: "interviews.questions",
          ascending: true,
        })
        .order("timestamp", { referencedTable: "messages", ascending: true })
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return session;
    }),

  sendMessage: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string().min(1),
        contentType: z
          .enum(["TEXT", "AUDIO", "FILE", "IMAGE", "WHITEBOARD"])
          .default("TEXT"),
        questionId: z.string().optional(),
        internal: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id, status, startedAt, lastActivityAt, activitySegments, interviewId")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (
        session.status === "COMPLETED" ||
        session.status === "ABANDONED"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Session is no longer active",
        });
      }

      const { data: userMessage } = await ctx.supabase
        .from("messages")
        .insert({
          sessionId: input.sessionId,
          role: input.internal ? ("SYSTEM" as const) : ("USER" as const),
          content: input.content,
          contentType: input.contentType,
          questionId: input.questionId ?? null,
          wordCount: input.content.split(/\s+/).length,
        })
        .select()
        .single();

      await ctx.supabase
        .from("sessions")
        .update({ lastActivityAt: new Date().toISOString() })
        .eq("id", input.sessionId);

      return { userMessage };
    }),

  saveWhiteboard: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        drawingId: z.string(),
        label: z.string().optional(),
        snapshotData: z.string(),
        imageDataUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { data: existing } = await ctx.supabase
        .from("messages")
        .select("id")
        .eq("sessionId", input.sessionId)
        .eq("contentType", "WHITEBOARD")
        .eq("content", input.drawingId)
        .single();

      const msgData = {
        sessionId: input.sessionId,
        role: "USER" as const,
        content: input.drawingId,
        contentType: "WHITEBOARD" as const,
        whiteboardData: {
          ...JSON.parse(input.snapshotData),
          label: input.label ?? "Drawing",
        },
        ...(input.imageDataUrl
          ? { whiteboardImageUrl: input.imageDataUrl }
          : {}),
      };

      let message;
      if (existing) {
        const result = await ctx.supabase
          .from("messages")
          .update(msgData)
          .eq("id", existing.id)
          .select()
          .single();
        message = requireVoiceStorageResult('update whiteboard evidence', result);
      } else {
        const result = await ctx.supabase
          .from("messages")
          .insert(msgData)
          .select()
          .single();
        message = requireVoiceStorageResult('insert whiteboard evidence', result);
      }

      return { message };
    }),

  deleteWhiteboard: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        drawingId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.supabase
        .from("messages")
        .delete()
        .eq("sessionId", input.sessionId)
        .eq("contentType", "WHITEBOARD")
        .eq("content", input.drawingId);
      requireVoiceStorageResult('delete whiteboard evidence', result);

      return { success: true };
    }),

  saveCode: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        snippetId: z.string(),
        label: z.string().optional(),
        snapshotData: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { data: existing } = await ctx.supabase
        .from("messages")
        .select("id")
        .eq("sessionId", input.sessionId)
        .eq("contentType", "CODE")
        .eq("content", input.snippetId)
        .single();

      const parsed = JSON.parse(input.snapshotData);
      const msgData = {
        sessionId: input.sessionId,
        role: "USER" as const,
        content: input.snippetId,
        contentType: "CODE" as const,
        whiteboardData: {
          ...parsed,
          label: input.label ?? "Code Snippet",
        },
      };

      let message;
      if (existing) {
        const result = await ctx.supabase
          .from("messages")
          .update(msgData)
          .eq("id", existing.id)
          .select()
          .single();
        message = requireVoiceStorageResult('update code evidence', result);
      } else {
        const result = await ctx.supabase
          .from("messages")
          .insert(msgData)
          .select()
          .single();
        message = requireVoiceStorageResult('insert code evidence', result);
      }

      return { message };
    }),

  deleteCode: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        snippetId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.supabase
        .from("messages")
        .delete()
        .eq("sessionId", input.sessionId)
        .eq("contentType", "CODE")
        .eq("content", input.snippetId);
      requireVoiceStorageResult('delete code evidence', result);

      return { success: true };
    }),

  updateCurrentQuestion: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        questionId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sessionResult = await ctx.supabase.from("sessions")
        .select("id, interviewId, status").eq("id", input.sessionId).single();
      requireVoiceStorageResult('load interview progress', sessionResult);
      const session = sessionResult.data;
      if (!session) throw new Error('Interview session no longer exists');
      if (session.status !== 'IN_PROGRESS') throw new Error('Interview session is not active');
      const questionResult = await ctx.supabase.from("questions")
        .select("id").eq("id", input.questionId).eq("interviewId", session.interviewId).maybeSingle();
      requireVoiceStorageResult('verify interview question', questionResult);
      if (!questionResult.data) throw new Error('Question does not belong to this interview');
      const result = await ctx.supabase
        .from("sessions")
        .update({
          currentQuestionId: input.questionId,
          lastActivityAt: new Date().toISOString(),
        })
        .eq("id", input.sessionId)
        .eq("interviewId", session.interviewId)
        .eq("status", "IN_PROGRESS")
        .select("id").maybeSingle();
      requireVoiceStorageResult('save interview progress', result);
      if (!result.data) throw new Error('Interview session no longer active');
      return { success: true };
    }),

  complete: sessionWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const sessionResult = await ctx.supabase
        .from("sessions")
        .select("id, startedAt, status, voiceRevision")
        .eq("id", input.id)
        .single();
      const session = requireVoiceStorageResult('load session completion version', sessionResult);

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (session.status === 'COMPLETED') return {success: true};

      const { data: firstMsg } = await ctx.supabase
        .from("messages")
        .select("timestamp")
        .eq("sessionId", input.id)
        .order("timestamp", { ascending: true })
        .limit(1)
        .single();

      const actualStart = firstMsg?.timestamp
        ? new Date(firstMsg.timestamp).getTime()
        : new Date(session.startedAt).getTime();
      const now = new Date();
      const duration = Math.round((now.getTime() - actualStart) / 1000);

      const completionResult = await ctx.supabase
        .from("sessions")
        .update({
          status: "COMPLETED" as const,
          completedVoiceRevision: session.voiceRevision,
          completedAt: now.toISOString(),
          startedAt: new Date(actualStart).toISOString(),
          totalDurationSeconds: duration,
        })
        .eq("id", input.id).select('id').maybeSingle();
      requireVoiceStorageResult('complete interview session', completionResult);
      if (!completionResult.data) throw new TRPCError({code:'NOT_FOUND',message:'Interview session no longer exists'});

      return { success: true };
    }),

  reportAntiCheatingViolation: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        violation: z.object({
          type: z.enum(["page_departure", "paste", "multi_screen", "tab_switch", "focus_lost", "copy", "cut"]),
          timestamp: z.number(),
          detail: z.string().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("antiCheatingLog")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      const log = Array.isArray(session.antiCheatingLog) ? session.antiCheatingLog : [];
      log.push(input.violation);

      await ctx.supabase
        .from("sessions")
        .update({ antiCheatingLog: log })
        .eq("id", input.sessionId);

      return { success: true };
    }),

  listAll: protectedProcedure
    .input(
      z.object({
        status: z
          .enum(["IN_PROGRESS", "COMPLETED", "ABANDONED"])
          .optional(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Get interviews accessible via org membership
      const { data: memberships } = await ctx.supabase
        .from("organization_members")
        .select("workspaceId")
        .eq("userId", ctx.user.id);

      const orgIds = (memberships ?? []).map(
        (m: { workspaceId: string }) => m.workspaceId,
      );
      if (orgIds.length === 0) return { sessions: [] };

      const { data: projects } = await ctx.supabase
        .from("projects")
        .select("id")
        .in("organizationId", orgIds);

      const allProjIds = (projects ?? []).map((p: { id: string }) => p.id);
      const projectIds = await filterAccessibleProjectIds(ctx.supabase, allProjIds, ctx.user.id);
      if (projectIds.length === 0) return { sessions: [] };

      const { data: userInterviews } = await ctx.supabase
        .from("interviews")
        .select("id")
        .in("projectId", projectIds);

      const interviewIds = (userInterviews ?? []).map((i: { id: string }) => i.id);
      if (interviewIds.length === 0) return { sessions: [] };

      let query = ctx.supabase
        .from("sessions")
        .select(
          "*, interview:interviews!inner(id, title, chatEnabled, voiceEnabled, videoEnabled), messages(id)",
        )
        .in("interviewId", interviewIds)
        .order("createdAt", { ascending: false })
        .limit(input.limit);

      if (input.status) {
        query = query.eq("status", input.status);
      }

      const { data: raw } = await query;

      const sessions = (raw ?? []).map((s) => ({
        ...s,
        _count: {
          messages: (s.messages as { id: string }[])?.length ?? 0,
        },
      }));

      return { sessions };
    }),

  listByInterview: protectedProcedure
    .input(
      z.object({
        interviewId: z.string(),
        status: z
          .enum(["IN_PROGRESS", "COMPLETED", "ABANDONED"])
          .optional(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data: interview } = await ctx.supabase
        .from("interviews")
        .select("id, projectId, project:projects!inner(organizationId)")
        .eq("id", input.interviewId)
        .single();

      if (!interview) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const project = interview.project as unknown as { organizationId: string };
      const { data: membership } = await ctx.supabase
        .from("organization_members")
        .select("role")
        .eq("workspaceId", project.organizationId)
        .eq("userId", ctx.user.id)
        .single();

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of this organization" });
      }

      const projAccess = await hasProjectAccess(ctx.supabase, interview.projectId, ctx.user.id);
      if (!projAccess) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this project" });
      }

      const limit = input.limit;

      let query = ctx.supabase
        .from("sessions")
        .select("*, messages(id)")
        .eq("interviewId", input.interviewId)
        .order("createdAt", { ascending: false })
        .limit(limit + 1);

      if (input.status) {
        query = query.eq("status", input.status);
      }

      const { data: raw } = await query;
      const rows = raw ?? [];

      const sessions = rows.slice(0, limit).map((s) => ({
        ...s,
        _count: {
          messages: (s.messages as { id: string }[])?.length ?? 0,
        },
      }));

      let nextCursor: string | undefined;
      if (rows.length > limit) {
        nextCursor = rows[limit - 1].id;
      }

      return { sessions, nextCursor };
    }),

  saveRecording: sessionWriteProcedure
    .input(
      z.object({
        sessionId: z.string(),
        audioRecordingUrl: z.string().optional(),
        audioDuration: z.number().optional(),
        screenshots: z
          .array(
            z.object({
              url: z.string(),
              path: z.string(),
              timestamp: z.string(),
              type: z.enum(["camera", "screen"]),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {};
      if (input.audioRecordingUrl) {
        updateData.audioRecordingUrl = input.audioRecordingUrl;
      }
      if (input.audioDuration !== undefined) {
        updateData.audioDuration = input.audioDuration;
      }
      if (input.screenshots) {
        updateData.screenshots = input.screenshots;
      }

      if (Object.keys(updateData).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No recording metadata supplied" });
      }

      const { data, error } = await ctx.supabase
        .from("sessions")
        .update(updateData)
        .eq("id", input.sessionId)
        .select("id")
        .maybeSingle();

      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }

      if (!data) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recording session no longer exists" });
      }
      return { success: true, sessionId: data.id };
    }),

  deleteMany: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { data: sessions } = await ctx.supabase
        .from("sessions")
        .select("id, interview:interviews!inner(projectId, project:projects!inner(organizationId))")
        .in("id", input.ids);

      await Promise.all(
        (sessions ?? []).map(async (s) => {
          const interviewData = s.interview as unknown as {
            projectId: string;
            project: { organizationId: string };
          };
          const orgId = interviewData?.project?.organizationId;
          if (!orgId) {
            throw new TRPCError({ code: "NOT_FOUND" });
          }
          const { data: membership } = await ctx.supabase
            .from("organization_members")
            .select("role")
            .eq("workspaceId", orgId)
            .eq("userId", ctx.user.id)
            .single();

          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Not authorized to delete these sessions",
            });
          }

          const projAccess = await hasProjectAccess(ctx.supabase, interviewData.projectId, ctx.user.id);
          if (!projAccess) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Not authorized to delete these sessions",
            });
          }
        })
      );

      await ctx.supabase.from("sessions").delete().in("id", input.ids);

      return { deleted: input.ids.length };
    }),
});

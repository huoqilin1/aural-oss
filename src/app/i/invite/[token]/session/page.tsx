"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { AntiCheatingGuard } from "@/components/session/anti-cheating-banner";
import { IntervieweeOnboarding } from "@/components/session/interviewee-onboarding";
import { PreparingScreen } from "@/components/session/preparing-screen";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc/client";
import {
  candidateFacingQuestionCount,
  isProgressiveOpeningOnly,
} from "@/lib/voice/dynamic-question-sync";
import { buildInviteResumeState } from "@/lib/voice/invite-resume-state";
import { CheckCircle2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useRecruitmentOnboardingGate } from "@/hooks/use-recruitment-onboarding-gate";

const ChatInterface = dynamic(
  () => import("@/components/session/chat-interface").then((m) => m.ChatInterface),
  { ssr: false, loading: () => <PreparingScreen /> },
);
const VoiceInterface = dynamic(
  () => import("@/components/session/voice-interface").then((m) => m.VoiceInterface),
  { ssr: false, loading: () => <PreparingScreen /> },
);

export default function InviteSessionPage() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();

  const [completed, setCompleted] = useState(false);
  const [completionReason, setCompletionReason] = useState<string | undefined>();

  const handleComplete = (reason?: string) => {
    setCompletionReason(reason);
    setCompleted(true);
  };

  const candidate = trpc.candidate.getByToken.useQuery(
    { token },
    { retry: false },
  );

  const candidateInterview = (candidate.data as any)?.interview;
  const candidateSession = (candidate.data as any)?.session;
  const isOprunRecruitmentInterview = /^数君招聘\s*·\s*/.test(
    String(candidateInterview?.title ?? ""),
  );
  const candidateResumeState = candidateSession && candidateInterview
    ? buildInviteResumeState(
        candidateInterview.questions ?? [],
        candidateSession.currentQuestionId,
        candidateSession.messages ?? [],
      )
    : null;
  const {
    ready: onboardingReady,
    done: onboardingDone,
    complete: completeOnboarding,
  } = useRecruitmentOnboardingGate({
    isRecruitmentInterview: isOprunRecruitmentInterview,
    sessionId: candidateSession?.id,
    hasServerProgress: !!candidateResumeState?.isResuming,
  });
  const isWaitingForGeneratedQuestions = isProgressiveOpeningOnly(
    candidateInterview?.questions ?? [],
  );
  const refetchCandidate = candidate.refetch;

  useEffect(() => {
    if (!isWaitingForGeneratedQuestions) return;
    const timer = window.setInterval(() => {
      void refetchCandidate();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [isWaitingForGeneratedQuestions, refetchCandidate]);

  useEffect(() => {
    if (candidate.isError) {
      router.replace(`/i/invite/${token}`);
    }
    if (candidate.data) {
      const session = (candidate.data as any).session;
      if (!session) {
        router.replace(`/i/invite/${token}`);
      }
    }
  }, [candidate.data, candidate.isError, token, router]);

  if (candidate.isLoading || !candidate.data) {
    return <PreparingScreen />;
  }

  const session = (candidate.data as any).session;
  const interview = (candidate.data as any).interview;
  const displayedQuestionCount = candidateFacingQuestionCount(
    interview.questions ?? [],
  );

  if (!session) {
    return <PreparingScreen />;
  }

  if (!onboardingReady) {
    return <PreparingScreen />;
  }

  const resumeState = buildInviteResumeState(
    interview.questions ?? [],
    session.currentQuestionId,
    session.messages ?? [],
  );
  const resumeTextMessages = resumeState.orderedMessages
    .filter((message: any) => message.contentType === "TEXT")
    .map((message: any) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
  const resumeDrawings = resumeState.orderedMessages
    .filter((message: any) => message.contentType === "WHITEBOARD" && message.whiteboardData)
    .map((message: any) => ({
      id: message.content,
      label: (message.whiteboardData as Record<string, unknown>)?.label as string ?? "Drawing",
      snapshotData: JSON.stringify(message.whiteboardData),
    }));

  if (completed || session.status === "COMPLETED") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="mx-auto h-16 w-16 text-secondary-500" />
            <h2 className="mt-4 text-2xl font-bold">测试已完成</h2>
            {completionReason === "TIME_LIMIT_EXCEEDED" && (
              <p className="mt-2 text-sm text-amber-600">
                测试时间已到,系统自动结束了本次测试。
              </p>
            )}
            <p className="mt-2 text-muted-foreground">
              面试已顺利完成，感谢你的时间和用心的回答，你的每一题都已被完整记录。HR 会尽快查看结果，通常在一个工作日内与你联系。
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 招聘面试同样先看「面试须知」:候选人读说明的同时,后台正好继续生成定制题
  // (王总 2026-08-20:说明要放在最前面,答完题怎么进下一题必须提前告知)
  if (!onboardingDone) {
    return (
      <IntervieweeOnboarding
        interviewTitle={interview.title}
        interviewDescription={interview.description}
        questionCount={displayedQuestionCount}
        timeLimitMinutes={interview.timeLimitMinutes}
        language={interview.language}
        antiCheatingEnabled={!!interview.antiCheatingEnabled}
        voiceEnabled={!!interview.voiceEnabled}
        chatEnabled={!!interview.chatEnabled}
        aiName={interview.aiName}
        questionTypes={resumeState.orderedQuestions.map((q: any) => q.type as string)}
        questionsReady={!isWaitingForGeneratedQuestions}
        onComplete={completeOnboarding}
      />
    );
  }

  const useVoice = interview.voiceEnabled;

  if (useVoice) {
    const interviewContext = {
      interviewId: interview.id,
      sessionId: session.id,
      timeLimitMinutes: interview.timeLimitMinutes ?? null,
      title: interview.title,
      objective: interview.objective,
      aiName: interview.aiName,
      aiTone: interview.aiTone,
      language: interview.language,
      followUpDepth: interview.followUpDepth,
      startQuestionIndex: resumeState.questionIndex,
      questions: resumeState.orderedQuestions.map((q: any) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        description: q.description,
        options: q.options,
        starterCode: q.starterCode as { language: string; code: string } | null,
        order: q.order,
      })),
    };

    return (
      <>
        <AntiCheatingGuard enabled={!!interview.antiCheatingEnabled} sessionId={session.id} />
        {/* 招聘进入铁律:阅读须知 -> 只点一次开始面试 -> 自动连接摄像头和麦克风。
            摄像头必须保留;不得在这里插入任何设备测试或第二次开始按钮。 */}
        <VoiceInterface
          sessionId={session.id}
          interviewId={interview.id}
          interviewTitle={interview.title}
          aiName={interview.aiName}
          questionCount={interview.questions.length}
          interviewContext={interviewContext}
          durationMinutes={interview.timeLimitMinutes ?? undefined}
          initialMessages={resumeState.isResuming ? resumeTextMessages : undefined}
          initialDrawings={resumeState.isResuming && resumeDrawings.length ? resumeDrawings : undefined}
          chatEnabled={!!interview.chatEnabled}
          onComplete={handleComplete}
          videoMode={!!interview.videoEnabled}
          candidateName={(candidate.data as any).name}
          autoStart={isOprunRecruitmentInterview}
        />
      </>
    );
  }

  return (
    <>
      <AntiCheatingGuard enabled={!!interview.antiCheatingEnabled} sessionId={session.id} />
      <ChatInterface
        sessionId={session.id}
        interview={{
          ...interview,
          questions: interview.questions.map((q: any) => ({
            ...q,
            starterCode: q.starterCode as { language: string; code: string } | null,
          })),
        }}
        durationMinutes={interview.timeLimitMinutes ?? undefined}
        onComplete={handleComplete}
      />
    </>
  );
}

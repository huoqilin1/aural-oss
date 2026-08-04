"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { AntiCheatingGuard } from "@/components/session/anti-cheating-banner";
import { IntervieweeOnboarding } from "@/components/session/interviewee-onboarding";
import { PreparingScreen } from "@/components/session/preparing-screen";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc/client";
import { CheckCircle2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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
  const [onboardingDone, setOnboardingDone] = useState(false);

  const handleComplete = (reason?: string) => {
    setCompletionReason(reason);
    setCompleted(true);
  };

  const candidate = trpc.candidate.getByToken.useQuery(
    { token },
    { retry: false },
  );

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

  if (!session) {
    return <PreparingScreen />;
  }

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
              你的测试已顺利完成,感谢你的时间和用心的回答。
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!onboardingDone) {
    return (
      <IntervieweeOnboarding
        interviewTitle={interview.title}
        interviewDescription={interview.description}
        questionCount={interview.questions?.length ?? 0}
        timeLimitMinutes={interview.timeLimitMinutes}
        language={interview.language}
        antiCheatingEnabled={!!interview.antiCheatingEnabled}
        voiceEnabled={!!interview.voiceEnabled}
        chatEnabled={!!interview.chatEnabled}
        aiName={interview.aiName}
        questionTypes={(interview.questions ?? []).map((q: any) => q.type as string)}
        onComplete={() => setOnboardingDone(true)}
      />
    );
  }

  const resumeMessages = session.messages ?? [];
  const resumeQuestionIndex = (() => {
    if (!session.currentQuestionId) return 0;
    const index = (interview.questions ?? []).findIndex(
      (question: any) => question.id === session.currentQuestionId,
    );
    return index >= 0 ? index : 0;
  })();
  const isResuming = resumeMessages.length > 0 || resumeQuestionIndex > 0;
  const resumeTextMessages = resumeMessages
    .filter((message: any) => message.contentType === "TEXT")
    .map((message: any) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
  const resumeDrawings = resumeMessages
    .filter((message: any) => message.contentType === "WHITEBOARD" && message.whiteboardData)
    .map((message: any) => ({
      id: message.id,
      label: message.whiteboardData?.label ?? "Drawing",
      snapshotData: JSON.stringify(message.whiteboardData),
    }));

  const useVoice = interview.voiceEnabled;

  if (useVoice) {
    const interviewContext = {
      interviewId: interview.id,
      sessionId: session.id,
      externalCorrelationId: interview.externalCorrelationId,
      title: interview.title,
      objective: interview.objective,
      aiName: interview.aiName,
      aiTone: interview.aiTone,
      language: interview.language,
      followUpDepth: interview.followUpDepth,
      startQuestionIndex: isResuming ? resumeQuestionIndex : undefined,
      questions: interview.questions.map((q: any) => ({
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
        <VoiceInterface
          sessionId={session.id}
          interviewId={interview.id}
          interviewTitle={interview.title}
          aiName={interview.aiName}
          questionCount={interview.questions.length}
          interviewContext={interviewContext}
          durationMinutes={interview.timeLimitMinutes ?? undefined}
          initialMessages={isResuming ? resumeTextMessages : undefined}
          initialDrawings={isResuming && resumeDrawings.length ? resumeDrawings : undefined}
          chatEnabled={!!interview.chatEnabled}
          onComplete={handleComplete}
          videoMode={!!interview.videoEnabled}
          candidateName={(candidate.data as any).name}
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
        initialMessages={resumeMessages
          .filter((message: any) => message.contentType !== "WHITEBOARD")
          .map((message: any) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: String(message.timestamp),
          }))}
        initialQuestionIndex={isResuming ? resumeQuestionIndex : undefined}
        onComplete={handleComplete}
      />
    </>
  );
}

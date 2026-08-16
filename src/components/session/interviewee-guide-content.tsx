"use client";

import { cn } from "@/lib/utils";
import {
    Code2,
    MessageSquare,
    Mic,
    MicOff,
    PenLine,
    PhoneOff,
    SkipBack,
    SkipForward,
    Volume2,
} from "lucide-react";

interface GuideItem {
  title: string;
  description: string;
  illustration: React.ReactNode;
}

function VoiceAreaIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 text-primary">
          <Volume2 className="h-5 w-5 animate-pulse" />
          <span className="text-xs font-medium">AI 正在说话…</span>
        </div>
        <div className="flex items-center gap-[2px]">
          {Array.from({ length: 14 }).map((_, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-primary/60"
              style={{ height: `${6 + (i % 3) * 8}px` }}
            />
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground">
          自然说话,AI 自动回应
        </span>
      </div>
    </div>
  );
}

function MicControlIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary-500 text-white">
            <Mic className="h-4 w-4" />
          </div>
          <span className="text-[10px] font-medium text-secondary-600">已开麦</span>
        </div>
        <div className="text-xs text-muted-foreground">→</div>
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MicOff className="h-4 w-4" />
          </div>
          <span className="text-[10px] text-muted-foreground">已静音</span>
        </div>
      </div>
    </div>
  );
}

function ChatChannelIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <MessageSquare className="h-4 w-4" />
          </div>
          <span className="text-[10px] font-medium">聊天</span>
        </div>
        <div className="w-36 rounded-lg border bg-card p-2">
          <div className="mb-1 text-[9px] font-medium text-muted-foreground">聊天面板</div>
          <div className="space-y-1">
            <div className="rounded bg-muted px-1.5 py-0.5 text-[8px]">在这里输入消息…</div>
            <div className="rounded bg-primary/10 px-1.5 py-0.5 text-[8px] text-primary">AI 用文字回复</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolsIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
            <PenLine className="h-4 w-4" />
          </div>
          <span className="text-[10px]">白板</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
            <Code2 className="h-4 w-4" />
          </div>
          <span className="whitespace-nowrap text-[10px]">代码编辑器</span>
        </div>
        <div className="ml-2 w-28 rounded border bg-card p-1.5">
          <div className="mb-1 h-1 w-12 rounded bg-muted-foreground/20" />
          <div className="space-y-0.5">
            <div className="h-1 w-full rounded bg-muted-foreground/10" />
            <div className="h-1 w-20 rounded bg-muted-foreground/10" />
            <div className="h-1 w-24 rounded bg-muted-foreground/10" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="w-48 rounded-lg border bg-card p-2.5">
        <div className="mb-2 text-[9px] font-semibold text-muted-foreground">对话记录</div>
        <div className="space-y-1.5">
          <div className="flex items-start gap-1">
            <Volume2 className="mt-0.5 h-2.5 w-2.5 shrink-0 text-primary" />
            <div className="text-[8px]"><span className="font-medium text-primary">AI:</span> 介绍一下你自己</div>
          </div>
          <div className="flex items-start gap-1">
            <Mic className="mt-0.5 h-2.5 w-2.5 shrink-0 text-secondary-500" />
            <div className="text-[8px]"><span className="font-medium text-secondary-600">你:</span> 我有 5 年……</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NavigationIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <SkipBack className="h-3.5 w-3.5" />
          </div>
          <span className="text-[9px]">上一题</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <SkipForward className="h-3.5 w-3.5" />
          </div>
          <span className="text-[9px]">下一题</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <PhoneOff className="h-3.5 w-3.5" />
          </div>
          <span className="text-[9px]">结束</span>
        </div>
        <div className="ml-2 flex flex-col gap-1">
          <div className="h-1.5 w-20 rounded-full bg-muted">
            <div className="h-full w-8 rounded-full bg-primary" />
          </div>
          <span className="text-[9px] text-muted-foreground">第 1 / 5 题</span>
        </div>
      </div>
    </div>
  );
}

function ChatQuestionIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="w-48 space-y-1.5">
        <div className="rounded-2xl bg-muted px-3 py-2 text-[9px]">
          讲一次你解决复杂问题的经历。
        </div>
        <div className="ml-auto w-36 rounded-2xl bg-primary px-3 py-2 text-[9px] text-primary-foreground">
          在上一份工作里,我……
        </div>
        <div className="flex items-center gap-1">
          <div className="h-0.5 w-0.5 animate-bounce rounded-full bg-muted-foreground/50" />
          <div className="h-0.5 w-0.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:150ms]" />
          <div className="h-0.5 w-0.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function ChatInputIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="w-52 rounded-lg border bg-card p-2">
        <div className="flex items-end gap-1.5">
          <div className="flex-1 rounded-md border bg-background px-2 py-1.5 text-[9px] text-muted-foreground">
            输入你的回答…
          </div>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>
          </div>
        </div>
        <div className="mt-1.5 text-[8px] text-muted-foreground">按回车发送</div>
      </div>
    </div>
  );
}

function ChatProgressIllustration() {
  return (
    <div className="flex h-32 w-full items-center justify-center rounded-lg border bg-muted/30 p-3">
      <div className="w-48 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium">测试进度</span>
          <span className="rounded border px-1.5 py-0.5 text-[9px] font-medium">第 2/5 题</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted">
          <div className="h-full w-2/5 rounded-full bg-primary transition-all" />
        </div>
        <div className="text-[8px] text-muted-foreground">完成 40%</div>
      </div>
    </div>
  );
}

export function getVoiceGuideItems(): GuideItem[] {
  return [
    {
      title: "你的 AI 一面面试官",
      description:
        "中间区域显示 AI 一面面试官的状态,它会实时跟你说话、听你回答。",
      illustration: <VoiceAreaIllustration />,
    },
    {
      title: "麦克风控制",
      description:
        "点麦克风按钮可静音或取消静音。开麦后自然说话即可,AI 会自动回应。",
      illustration: <MicControlIllustration />,
    },
    {
      title: "文字聊天通道",
      description:
        "想打字?打开聊天面板,可以在语音对话之外用文字发消息。",
      illustration: <ChatChannelIllustration />,
    },
    {
      title: "白板和代码编辑器",
      description:
        "画图用白板,写代码用代码编辑器,它们会作为侧边面板打开。",
      illustration: <ToolsIllustration />,
    },
    {
      title: "对话记录",
      description:
        "完整的对话文字记录显示在右侧,可以随时回看说过的话。",
      illustration: <TranscriptIllustration />,
    },
    {
      title: "题目导航",
      description:
        "用上一题/下一题在题目间切换,进度条显示你的进度,测试完点结束。",
      illustration: <NavigationIllustration />,
    },
  ];
}

export function getChatGuideItems(): GuideItem[] {
  return [
    {
      title: "和 AI 对话",
      description:
        "题目以聊天消息的形式出现,AI 会带你逐题进行,并根据你的回答追问。",
      illustration: <ChatQuestionIllustration />,
    },
    {
      title: "输入你的回答",
      description:
        "在文本框里输入答案,按回车或点发送。可以慢慢组织、好好作答。",
      illustration: <ChatInputIllustration />,
    },
    {
      title: "白板和代码编辑器",
      description:
        "画图用白板,写代码用代码编辑器,它们会出现在聊天区上方。",
      illustration: <ToolsIllustration />,
    },
    {
      title: "查看进度",
      description:
        "进度条和题目计数显示你的进度,用返回箭头可以回看前面的题目。",
      illustration: <ChatProgressIllustration />,
    },
  ];
}

const STEP_ILLUSTRATION_MAP: Record<string, React.ReactNode> = {
  "voice-status": <VoiceAreaIllustration />,
  "voice-mic": <MicControlIllustration />,
  "voice-chat": <ChatChannelIllustration />,
  "voice-tools": <ToolsIllustration />,
  "voice-transcript": <TranscriptIllustration />,
  "voice-progress": <NavigationIllustration />,
  "chat-question": <ChatQuestionIllustration />,
  "chat-input": <ChatInputIllustration />,
  "chat-tools": <ToolsIllustration />,
  "chat-progress": <ChatProgressIllustration />,
  "chat-timer": <NavigationIllustration />,
};

export function getStepIllustration(stepId: string): React.ReactNode | null {
  return STEP_ILLUSTRATION_MAP[stepId] ?? null;
}

export function GuideStepCard({
  item,
  index,
  compact = false,
}: {
  item: GuideItem;
  index: number;
  compact?: boolean;
}) {
  return (
    <div className={cn(
      "overflow-hidden rounded-lg",
      compact ? "border bg-card p-3" : "p-0",
    )}>
      {!compact && item.illustration}
      <div className={cn("flex items-start gap-3", !compact && "mt-3")}>
        <div className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold",
          compact ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-xs",
        )}>
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn("font-semibold", compact ? "text-xs" : "text-sm")}>
            {item.title}
          </p>
          <p className={cn(
            "mt-0.5 leading-relaxed text-muted-foreground",
            compact ? "text-[11px]" : "text-xs",
          )}>
            {item.description}
          </p>
        </div>
      </div>
    </div>
  );
}

"use client";
import {candidateFetch as fetch} from '@/lib/voice/candidate-fetch';

import { useState } from "react";
import { CheckCircle2, Loader2, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { FEEDBACK_TAGS } from "@/lib/voice/feedback";
import { cn } from "@/lib/utils";

/**
 * 完成页匿名反馈问卷(共享组件,四个完成态页面复用)。
 * 只收集评分/标签/备注,不收集姓名与联系方式;备注里的 PII 由后端入库前抹除。
 */
export function SessionFeedback({
  sessionId,
  inviteToken,
}: {
  sessionId?: string | null;
  inviteToken?: string;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);

  if (!sessionId) return null;

  const toggleTag = (tag: string) => {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const submit = async () => {
    if (!rating || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const res = await fetch("/api/voice/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, inviteToken, rating, tags, note }),
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setDone(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="py-8 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-secondary-500" />
          <p className="mt-3 text-sm text-muted-foreground">
            已收到你的反馈，感谢帮助我们把面试做得更好。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="py-6">
        <h3 className="font-heading text-base font-semibold">
          给本次面试一个反馈（选填）
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          你的反馈只用于改进面试体验，匿名提交，无需填写姓名或联系方式。
        </p>

        <div className="mt-4">
          <p className="text-sm font-medium">整体体验如何？</p>
          <div className="mt-2 flex items-center gap-1" role="radiogroup" aria-label="整体体验评分">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                aria-label={`${value} 星`}
                onClick={() => setRating(value)}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  rating === value
                    ? "bg-amber-500/20"
                    : "hover:bg-muted",
                )}
              >
                <Star
                  className={cn(
                    "h-5 w-5",
                    value <= (rating ?? 0)
                      ? "fill-amber-500 text-amber-500"
                      : "text-muted-foreground/40",
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium">哪些地方让你有感触？（可多选）</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {FEEDBACK_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                aria-pressed={tags.includes(tag)}
                onClick={() => toggleTag(tag)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  tags.includes(tag)
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium">其他建议（选填）</p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            className="mt-2"
            placeholder="说说你的想法，例如面试节奏、题目难度、语音效果……"
          />
        </div>

        {failed && (
          <p className="mt-2 text-xs text-destructive">
            提交失败，请稍后再试。
          </p>
        )}

        <Button
          className="mt-4 w-full"
          type="button"
          disabled={!rating || saving}
          onClick={() => void submit()}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          提交反馈
        </Button>
      </CardContent>
    </Card>
  );
}

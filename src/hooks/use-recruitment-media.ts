"use client";
import { useEffect, useMemo } from "react";
import { RecruitmentMediaAccess } from "@/lib/voice/recruitment-media-access";

export function useRecruitmentMedia(sessionId: string, video: boolean) {
  const media = useMemo(() => {
    // A different session owns a different lease even when its video setting matches.
    void sessionId;
    return new RecruitmentMediaAccess(video);
  }, [sessionId, video]);
  useEffect(() => {
    // React's strict effect replay must not dispose the still-mounted owner.
    const owners = media as RecruitmentMediaAccess & { owner?: object };
    const owner = {};
    owners.owner = owner;
    return () => {
      queueMicrotask(() => { if (owners.owner === owner) media.dispose(); });
    };
  }, [media]);
  return media;
}

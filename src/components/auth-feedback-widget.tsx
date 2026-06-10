"use client";

import { useEffect, useState } from "react";

import { useAuthIntent } from "@/components/auth-intent";

type FeedbackWidgetComponent = React.ComponentType;

export function AuthFeedbackWidget() {
  const { authActive } = useAuthIntent();
  const [FeedbackWidget, setFeedbackWidget] =
    useState<FeedbackWidgetComponent | null>(null);

  useEffect(() => {
    if (!authActive || FeedbackWidget) return;
    let cancelled = false;
    void import("@/components/feedback-widget").then((mod) => {
      if (!cancelled) setFeedbackWidget(() => mod.FeedbackWidget);
    });
    return () => {
      cancelled = true;
    };
  }, [FeedbackWidget, authActive]);

  if (!FeedbackWidget) return null;
  return authActive ? <FeedbackWidget /> : null;
}

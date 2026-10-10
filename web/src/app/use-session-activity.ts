import { useEffect, useRef } from "react";
import { createActivityTracker, type ActivityKind, type ActivityTracker } from "@/lib/session-activity";

export function useSessionActivity(
  scheduleId: string | null,
  active: boolean,
  answer: string,
  prompt: string,
) {
  const trackerRef = useRef<ActivityTracker | null>(null);
  const promptRef = useRef(prompt);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    if (!active || !scheduleId) return;
    const send = (kind: ActivityKind) => {
      void fetch(`/api/challenge/${scheduleId}/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const tracker = createActivityTracker(send);
    trackerRef.current = tracker;
    tracker.start({ hidden: document.hidden, focused: document.hasFocus() });

    const onVisibility = () => tracker.visibilityChanged(document.hidden);
    const onBlur = () => tracker.focusChanged(false);
    const onFocus = () => tracker.focusChanged(true);
    const onCopy = () => tracker.copied(window.getSelection()?.toString() ?? "", promptRef.current);
    const onPaste = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) tracker.pasted();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      trackerRef.current = null;
    };
  }, [active, scheduleId]);

  useEffect(() => {
    trackerRef.current?.answerChanged(answer);
  }, [answer]);
}

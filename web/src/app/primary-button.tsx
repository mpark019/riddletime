import type { ButtonHTMLAttributes } from "react";
import { FloatingQuestionMarks } from "./floating-question-marks";

export function PrimaryButton({ className = "", children, markStart = 0, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { markStart?: number }) {
  return (
    <button
      {...props}
      className={`navy-surface relative isolate overflow-hidden rounded-md border border-transparent font-semibold transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <FloatingQuestionMarks contained compact start={markStart} />
      {children}
    </button>
  );
}

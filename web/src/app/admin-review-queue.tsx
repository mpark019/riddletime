"use client";

import { useCallback, useEffect, useState } from "react";
import type { PendingReview } from "@/server/challenges/image-submission";
import {
  buildReviewRequest,
  canGradePartial,
  MAX_REVIEW_COMMENT,
  type GradeChoice,
  type GradeDraft,
} from "@/lib/review-grade";
import { PrimaryButton } from "./primary-button";

const OUTCOME_LABEL: Record<GradeChoice, string> = { full: "Full points", partial: "Partial", none: "No points" };

async function readError(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? fallback;
}

function formatSigned(points: number) {
  return points > 0 ? `+${points}` : String(points);
}

function formatSubmitted(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AdminReviewQueue({ onGraded }: { onGraded?: () => void }) {
  const [submissions, setSubmissions] = useState<PendingReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/submissions/pending", { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response, "Could not load submissions."));
    const body = await response.json() as { submissions: PendingReview[] };
    setSubmissions(body.submissions);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load().catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load submissions.");
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  async function handleGraded(item: PendingReview, summary: string) {
    setSubmissions((list) => list?.filter((entry) => entry.submissionId !== item.submissionId) ?? list);
    setNotice(`${item.playerName}: ${summary}`);
    onGraded?.();
    await load().catch(() => undefined);
  }

  const count = submissions?.length ?? 0;
  return <section className="mx-auto w-[calc(100%-2rem)] max-w-[1280px] pt-5 lg:pt-8" aria-labelledby="image-reviews-title">
    <header className="flex flex-wrap items-center justify-between gap-3 pb-4">
      <h2 id="image-reviews-title" className="text-2xl font-semibold tracking-tight lg:text-[28px]">
        Image reviews{submissions !== null && count > 0 && <span className="ml-3 rounded-full bg-white/15 px-3 py-0.5 align-middle text-sm font-semibold tabular-nums">{count}</span>}
      </h2>
      <button type="button" onClick={() => void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load submissions."))} className="text-sm font-semibold underline underline-offset-4">Refresh</button>
    </header>
    {error && <p role="alert" className="mb-3 rounded-md border border-red-300/40 bg-red-500/15 px-4 py-3 text-sm">{error}</p>}
    {notice && <p role="status" className="mb-3 rounded-md border border-white/20 bg-white/10 px-4 py-3 text-sm">{notice}</p>}
    {submissions === null && !error && <p className="text-sm text-white/60">Loading…</p>}
    {submissions?.length === 0 && <p className="text-sm text-white/60">No submissions waiting for review.</p>}
    <ul className="space-y-4">
      {submissions?.map((item) => <ReviewCard key={item.submissionId} item={item} onEnlarge={setEnlarged} onGraded={(summary) => handleGraded(item, summary)} />)}
    </ul>
    {enlarged && <button type="button" aria-label="Close image" onClick={() => setEnlarged(null)} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URLs are not configured for next/image */}
      <img src={enlarged} alt="Submitted image, enlarged" className="max-h-full max-w-full object-contain" />
    </button>}
  </section>;
}

function Thumbnails({ images, label, onEnlarge }: { images: Array<{ id: string; url: string }>; label: string; onEnlarge: (url: string) => void }) {
  return <ul className="flex flex-wrap gap-2">
    {images.map((image, index) => <li key={image.id}>
      <button type="button" onClick={() => onEnlarge(image.url)} aria-label={`Enlarge ${label} ${index + 1}`} className="block overflow-hidden rounded-md border border-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URLs are not configured for next/image */}
        <img src={image.url} alt={`${label} ${index + 1}`} className="h-28 w-28 object-cover" />
      </button>
    </li>)}
  </ul>;
}

function ReviewCard({ item, onEnlarge, onGraded }: { item: PendingReview; onEnlarge: (url: string) => void; onGraded: (summary: string) => Promise<void> }) {
  const [draft, setDraft] = useState<GradeDraft>({ choice: null, partialPoints: "", comment: "" });
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const partialAllowed = canGradePartial(item.basePoints);
  const request = buildReviewRequest(draft, item.basePoints);
  const idPrefix = `review-${item.submissionId}`;

  async function submit() {
    if (!request || inflight) return;
    setInflight(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/submissions/${item.submissionId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        setError(await readError(response, "Could not save this grade."));
        return;
      }
      const graded = await response.json() as { outcome: GradeChoice; totalPoints: number };
      await onGraded(`${OUTCOME_LABEL[graded.outcome]}, ${formatSigned(graded.totalPoints)} points`);
    } catch {
      setError("Could not save this grade.");
    } finally {
      setInflight(false);
    }
  }

  function choose(choice: GradeChoice) {
    setDraft((current) => ({ ...current, choice }));
  }

  return <li className="rounded-md border border-white/20 bg-black/[0.04] p-4 sm:p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-lg font-semibold">{item.playerName}</h3>
      <p className="text-sm text-white/60">{item.activeDate} · submitted {formatSubmitted(item.submittedAt)}</p>
    </div>
    <div className="mt-3 grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/55">Puzzle{item.puzzleName ? `: ${item.puzzleName}` : ""}</p>
          {item.prompt && <p className="mt-1 whitespace-pre-wrap">{item.prompt}</p>}
          {item.promptImageUrl && <div className="mt-2"><Thumbnails images={[{ id: "prompt", url: item.promptImageUrl }]} label="Prompt image" onEnlarge={onEnlarge} /></div>}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/55">Submitted images</p>
          <div className="mt-2">
            {item.images.length === 0
              ? <p className="text-sm text-white/60">Images could not be loaded. Refresh to retry.</p>
              : <Thumbnails images={item.images} label="Submitted image" onEnlarge={onEnlarge} />}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/55">Player note</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{item.note ?? <span className="text-white/60">No note.</span>}</p>
        </div>
      </div>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset className="space-y-2" disabled={inflight}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-white/55">Grade</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={idPrefix} checked={draft.choice === "full"} onChange={() => choose("full")} />
            Full points ({formatSigned(item.basePoints)})
          </label>
          <div className="space-y-1">
            <label className={`flex items-center gap-2 text-sm ${partialAllowed ? "" : "opacity-60"}`}>
              <input type="radio" name={idPrefix} disabled={!partialAllowed} checked={draft.choice === "partial"} onChange={() => choose("partial")} />
              Partial
            </label>
            {partialAllowed
              ? <input
                type="number" inputMode="numeric" min={1} max={item.basePoints - 1} step={1}
                value={draft.partialPoints} placeholder={`1 to ${item.basePoints - 1}`}
                aria-label={`Partial points for ${item.playerName}`}
                disabled={draft.choice !== "partial"}
                onChange={(event) => setDraft((current) => ({ ...current, partialPoints: event.target.value }))}
                className="ml-6 w-32 rounded-md border border-white/40 bg-black/[0.04] px-3 py-1.5 text-sm text-white placeholder:text-white/45 focus:outline-2 focus:outline-white disabled:opacity-50" />
              : <p className="ml-6 text-xs text-white/60">Needs a puzzle worth at least 2 points.</p>}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={idPrefix} checked={draft.choice === "none"} onChange={() => choose("none")} />
            No points ({item.failurePenaltyPoints > 0 ? `-${item.failurePenaltyPoints} penalty` : "no penalty"})
          </label>
        </fieldset>
        <div>
          <label htmlFor={`${idPrefix}-comment`} className="text-xs font-semibold uppercase tracking-wide text-white/55">Comment (optional)</label>
          <textarea
            id={`${idPrefix}-comment`} rows={3} maxLength={MAX_REVIEW_COMMENT} value={draft.comment} disabled={inflight}
            onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))}
            className="mt-1 w-full rounded-md border border-white/40 bg-black/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/45 focus:outline-2 focus:outline-white" />
          <p className="mt-1 text-right text-xs tabular-nums text-white/60">{MAX_REVIEW_COMMENT - draft.comment.length} left</p>
        </div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <PrimaryButton type="submit" disabled={!request || inflight} className="w-full px-4 py-2.5">
          {inflight ? "Saving…" : "Save grade"}
        </PrimaryButton>
      </form>
    </div>
  </li>;
}

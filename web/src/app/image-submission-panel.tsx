"use client";

import { useEffect, useRef, useState } from "react";
import type { PlayerChallengeState, SubmissionImage } from "@/lib/challenge-state";
import { PrimaryButton } from "./primary-button";
import { prepareImageForUpload } from "@/lib/image-resize";
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_NOTE_LENGTH, pickImageFiles } from "./image-submission-helpers";

type ImagePlay = Exclude<PlayerChallengeState, { status: "not_started" }>;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? fallback;
}

// A thumbnail that opens the full image in an overlay; Escape or a click closes it.
export function ZoomableImage({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label={`View full size: ${alt}`}
      className="block w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className={className} />
    </button>
    {open && <div role="dialog" aria-modal="true" aria-label={alt} onClick={() => setOpen(false)}
      className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/85 p-4">
      <button type="button" aria-label="Close image" onClick={() => setOpen(false)}
        className="fixed right-4 top-4 z-10 rounded-md bg-white px-3 py-1.5 text-3xl font-bold leading-none text-[#e00000] shadow-lg hover:bg-[#ffe5e5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">×</button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>}
  </>;
}

export function PromptImage({ url }: { url: string | null | undefined }) {
  if (!url) return null;
  return <div className="mt-5 inline-block max-w-full">
    <ZoomableImage src={url} alt="Puzzle prompt" className="max-h-96 w-auto max-w-full rounded-md border border-white/25" />
  </div>;
}

export function ImagePrompt({ prompt, url }: { prompt: string; url: string | null | undefined }) {
  return <div className="mt-8 border-y border-white/25 py-8">
    {prompt.trim() !== "" && <p className="whitespace-pre-line text-balance text-2xl font-medium leading-relaxed sm:text-3xl">{prompt}</p>}
    <PromptImage url={url} />
  </div>;
}

export function ImageGallery({ images, title = "Your images", onRemove, disabled = false }: {
  images: readonly SubmissionImage[];
  title?: string;
  onRemove?: (image: SubmissionImage) => void;
  disabled?: boolean;
}) {
  if (images.length === 0) return null;
  return <div className="mt-6">
    <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">{title}</h4>
    <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {images.map((image, index) => <li key={image.id} className="min-w-0 rounded-md border border-white/25 bg-black/[0.04] p-2">
        <ZoomableImage src={image.url} alt={`Submitted image ${index + 1}`} className="h-36 w-full rounded object-cover" />
        {onRemove && <button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(image)}
          className="mt-2 w-full rounded-md border border-white/40 px-2 py-1 text-sm font-semibold hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >Remove</button>}
      </li>)}
    </ul>
  </div>;
}

export function ImageNote({ note, title = "Your note" }: { note: string | null | undefined; title?: string }) {
  if (!note) return null;
  return <div className="mt-6">
    <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">{title}</h4>
    <p className="mt-2 whitespace-pre-line">{note}</p>
  </div>;
}

export function ImagePreviewControls({ maxImages }: { maxImages: number | undefined }) {
  return <div className="mt-7">
    <p className="text-sm font-semibold text-white/70">Add images{maxImages ? ` (up to ${maxImages})` : ""}</p>
    <div className="mt-2 rounded-md border border-dashed border-white/40 px-4 py-6 text-center text-white/55">Choose images</div>
    <label htmlFor="image-note-preview" className="mt-5 block text-sm font-semibold text-white/70">Note (optional)</label>
    <textarea id="image-note-preview" disabled rows={3} className="mt-2 w-full rounded-md border border-white/70 bg-black/[0.06] px-4 py-3 text-white disabled:opacity-50" />
    <PrimaryButton type="button" disabled className="mt-5 px-6 py-3">Submit for review</PrimaryButton>
  </div>;
}

// Owns the draft controls; every endpoint answers with the authoritative play state.
export function ImageDraftPanel({ scheduleId, play, locked, onPlay }: {
  scheduleId: string;
  play: ImagePlay;
  locked: boolean;
  onPlay: (play: PlayerChallengeState, requestStartedAt: number, responseReceivedAt: number) => void;
}) {
  const images = play.images ?? [];
  const maxImages = play.maxImages ?? 1;
  const [note, setNote] = useState(play.note ?? "");
  const [savedNote, setSavedNote] = useState(play.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const disabled = busy || locked;

  async function send(url: string, init: RequestInit, fallback: string): Promise<boolean> {
    const startedAt = Date.now();
    const result = await fetch(url, init);
    if (!result.ok) {
      setError(await errorMessage(result, fallback));
      return false;
    }
    const body = await result.json() as { play: PlayerChallengeState };
    onPlay(body.play, startedAt, Date.now());
    return true;
  }

  async function run(action: () => Promise<boolean>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveNoteIfChanged(): Promise<boolean> {
    if (note === savedNote) return Promise.resolve(true);
    return send(`/api/challenge/${scheduleId}/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    }, "Could not save your note.").then((saved) => {
      if (saved) setSavedNote(note);
      return saved;
    });
  }

  async function upload(files: File[]) {
    const picked = pickImageFiles(files, images.length, maxImages, { checkSize: false });
    if (picked.errors.length > 0) setError(picked.errors.join(" "));
    if (picked.accepted.length === 0) return;
    await run(async () => {
      for (const original of picked.accepted) {
        const file = await prepareImageForUpload(original);
        if (file.size > MAX_IMAGE_BYTES) {
          setError(`${original.name} is larger than 5 MiB even after resizing.`);
          return false;
        }
        const body = new FormData();
        body.append("file", file);
        if (!await send(`/api/challenge/${scheduleId}/images`, { method: "POST", body }, `Could not upload ${file.name}.`)) {
          return false;
        }
      }
      return true;
    }, "Could not upload that image.");
  }

  async function remove(image: SubmissionImage) {
    await run(
      () => send(`/api/challenge/${scheduleId}/images/${encodeURIComponent(image.id)}`, { method: "DELETE" }, "Could not remove that image."),
      "Could not remove that image.",
    );
  }

  async function submitForReview() {
    setConfirming(false);
    await run(async () => {
      if (!await saveNoteIfChanged()) return false;
      return send(`/api/challenge/${scheduleId}/submit-images`, { method: "POST" }, "Could not submit your images.");
    }, "Could not submit your images.");
  }

  return <div className="mt-7">
    <p className="text-sm font-semibold text-white/70">Add images ({images.length}/{maxImages})</p>
    <input
      ref={input}
      type="file"
      accept={IMAGE_ACCEPT}
      multiple={maxImages > 1}
      hidden
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        void upload(files);
      }}
    />
    <button
      type="button"
      disabled={disabled || images.length >= maxImages}
      onClick={() => input.current?.click()}
      className="mt-2 w-full rounded-md border border-dashed border-white/50 px-4 py-6 text-center font-semibold hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
    >{busy ? "Working…" : images.length >= maxImages ? "Image limit reached" : "Choose images (PNG, JPEG, WebP or GIF; large photos are resized automatically)"}</button>

    <ImageGallery images={images} onRemove={(image) => void remove(image)} disabled={disabled} />

    <label htmlFor="image-note" className="mt-6 block text-sm font-semibold text-white/70">Note (optional)</label>
    <textarea
      id="image-note"
      value={note}
      maxLength={MAX_NOTE_LENGTH}
      rows={3}
      disabled={disabled}
      onChange={(event) => setNote(event.target.value)}
      onBlur={() => { if (!locked) void run(saveNoteIfChanged, "Could not save your note."); }}
      className="mt-2 w-full rounded-md border border-white/70 bg-black/[0.06] px-4 py-3 text-white placeholder:text-white/45 focus:outline-2 focus:outline-white disabled:opacity-50"
      placeholder="Anything the reviewer should know"
    />
    <p className="mt-1 text-xs text-white/55">{note.length}/{MAX_NOTE_LENGTH}</p>

    {confirming
      ? <div className="mt-5 rounded-md border border-amber-700/50 bg-amber-50 p-4">
        <p className="text-amber-900">Submitting locks your images and note. You cannot change them afterwards.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <PrimaryButton type="button" disabled={disabled} onClick={() => void submitForReview()} className="px-5 py-2.5">Confirm and submit</PrimaryButton>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-amber-900/40 px-5 py-2.5 font-semibold text-amber-900">Keep editing</button>
        </div>
      </div>
      : <PrimaryButton type="button" disabled={disabled || images.length === 0} onClick={() => setConfirming(true)} className="mt-5 px-6 py-3">Submit for review</PrimaryButton>}
    {error && <p role="alert" className="mt-4 rounded-md border border-red-700/50 bg-red-50 px-4 py-3 text-red-800">{error}</p>}
  </div>;
}

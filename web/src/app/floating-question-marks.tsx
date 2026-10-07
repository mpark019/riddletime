import type { CSSProperties } from "react";
import Image from "next/image";

const questionMarkVariants = [
  { glyph: "?", style: "sans" },
  { glyph: "?", style: "serif" },
  { glyph: "?", style: "mono" },
  { glyph: "？", style: "wide" },
  { glyph: "﹖", style: "small" },
] as const;

const dancingQuestionMark = { style: "dancing" } as const;
const dancingQuestionMarkFrequency = 0.22;

const questionMarks = createQuestionMarks();
const containedMarkCount = 28;
const compactMarkCount = 5;

function createQuestionMarks() {
  let seed = 284671;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };

  return Array.from({ length: 96 }, () => {
    const depth = random();
    const variant = random() < dancingQuestionMarkFrequency
      ? dancingQuestionMark
      : questionMarkVariants[Math.floor(random() * questionMarkVariants.length)];

    return {
      blur: `${((1 - depth) * 1.3 + random() * 0.6).toFixed(2)}px`,
      delay: `-${(random() * 11).toFixed(2)}s, -${(random() * 7).toFixed(2)}s`,
      driftX: `${(0.3 + depth * 1.2).toFixed(2)}rem`,
      driftY: `-${(0.4 + depth * 1.5).toFixed(2)}rem`,
      duration: `${(9 + random() * 6).toFixed(2)}s, ${(5 + random() * 4).toFixed(2)}s`,
      glow: `${(0.35 + depth * 1.5).toFixed(2)}rem`,
      left: `${(random() * 100).toFixed(2)}%`,
      opacity: `${(0.06 + depth * 0.3 + random() * 0.06).toFixed(2)}`,
      scale: `${(0.7 + depth * 0.3).toFixed(2)}`,
      size: `${(variant.style === "dancing" ? 1.75 + depth * 3.5 : 0.55 + depth * 4.6 + random() * 0.8).toFixed(2)}rem`,
      top: `${(random() * 100).toFixed(2)}%`,
      variant,
    };
  });
}

const smallMarks = questionMarks.filter(({ variant }) => variant.style !== "dancing");

export function FloatingQuestionMarks({ contained = false, compact = false, start = 0 }: { contained?: boolean; compact?: boolean; start?: number }) {
  const marks = compact
    ? Array.from({ length: compactMarkCount }, (_, offset) => smallMarks[(start + offset) % smallMarks.length])
    : contained ? questionMarks.slice(0, containedMarkCount) : questionMarks;
  const className = ["floating-question-marks", contained && "floating-question-marks--contained", compact && "floating-question-marks--compact"].filter(Boolean).join(" ");

  return (
    <div className={className} aria-hidden="true">
      {marks.map(({ blur, delay, driftX, driftY, duration, glow, left, opacity, scale, size, top, variant }, index) => (
        <span
          key={index}
          data-question-mark-style={variant.style}
          style={{
            "--mark-blur": blur,
            "--mark-drift-x": driftX,
            "--mark-drift-y": driftY,
            "--mark-glow": glow,
            "--mark-opacity": opacity,
            "--mark-scale": scale,
            "--mark-size": size,
            animationDelay: delay,
            animationDuration: duration,
            left,
            top,
          } as CSSProperties}
        >
          {variant.style === "dancing"
            ? <Image src="/images/dancing-alphabet/dancing-question.gif" alt="" width={140} height={171} unoptimized />
            : variant.glyph}
        </span>
      ))}
    </div>
  );
}

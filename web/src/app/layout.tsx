import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: "400" });

export const metadata: Metadata = {
  title: "riddletime",
  description: "Daily riddle challenges",
};

const questionMarkVariants = [
  { glyph: "?", style: "sans" },
  { glyph: "?", style: "serif" },
  { glyph: "?", style: "mono" },
  { glyph: "？", style: "wide" },
  { glyph: "﹖", style: "small" },
] as const;

const questionMarks = createQuestionMarks();

function createQuestionMarks() {
  let seed = 284671;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };

  return Array.from({ length: 96 }, () => {
    const depth = random();
    const variant = questionMarkVariants[Math.floor(random() * questionMarkVariants.length)];

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
      size: `${(0.55 + depth * 4.6 + random() * 0.8).toFixed(2)}rem`,
      top: `${(random() * 100).toFixed(2)}%`,
      variant,
    };
  });
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} min-h-full antialiased`}>
        <FloatingQuestionMarks />
        <div className="relative z-10 flex min-h-full flex-col">{children}</div>
      </body>
    </html>
  );
}

function FloatingQuestionMarks() {
  return (
    <div className="floating-question-marks" aria-hidden="true">
      {questionMarks.map(({ blur, delay, driftX, driftY, duration, glow, left, opacity, scale, size, top, variant }, index) => (
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
          {variant.glyph}
        </span>
      ))}
    </div>
  );
}

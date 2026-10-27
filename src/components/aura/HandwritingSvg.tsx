"use client";

import { motion, useReducedMotion } from "framer-motion";
import * as opentype from "opentype.js";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Caveat (OFL), served locally; Cyrillic first so Russian text never misses a glyph. */
export const DEFAULT_FONT_URLS = [
  "/fonts/caveat-cyrillic-400-normal.woff",
  "/fonts/caveat-latin-400-normal.woff",
];

const fontCache = new Map<string, Promise<opentype.Font>>();

function loadFont(url: string): Promise<opentype.Font> {
  let pending = fontCache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`font ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => opentype.parse(buffer));
    pending.catch(() => fontCache.delete(url));
    fontCache.set(url, pending);
  }
  return pending;
}

/** Lay out text glyph by glyph, taking each character from the first font that has it. */
export function buildTextPath(fonts: opentype.Font[], text: string, fontSize: number) {
  const out = new opentype.Path();
  let x = 0;
  let missing = 0;
  for (const ch of Array.from(text)) {
    const font = fonts.find((f) => f.charToGlyphIndex(ch) > 0) ?? fonts[0];
    if (font.charToGlyphIndex(ch) <= 0 && ch.trim()) missing += 1;
    const glyph = font.charToGlyph(ch);
    const scale = fontSize / font.unitsPerEm;
    out.extend(glyph.getPath(x, fontSize, fontSize));
    x += (glyph.advanceWidth ?? font.unitsPerEm * 0.5) * scale;
  }
  return { path: out, missing };
}

export type Stroke = { d: string; length: number };

/** Split a glyph path into contours, each with its approximate length, so they can be written one after another. */
export function splitStrokes(path: opentype.Path): Stroke[] {
  const strokes: Stroke[] = [];
  let cmds: opentype.PathCommand[] = [];
  let length = 0;
  let px = 0;
  let py = 0;
  const flush = () => {
    if (cmds.length > 1) {
      const p = new opentype.Path();
      p.commands = cmds;
      strokes.push({ d: p.toPathData(2), length: Math.max(length, 1) });
    }
    cmds = [];
    length = 0;
  };
  for (const c of path.commands) {
    if (c.type === "M") {
      flush();
      px = c.x;
      py = c.y;
    } else if (c.type !== "Z") {
      length += Math.hypot(c.x - px, c.y - py);
      px = c.x;
      py = c.y;
    }
    cmds.push(c);
  }
  flush();
  return strokes;
}

interface HandwritingSvgProps {
  path?: string;
  text?: string;
  fontUrls?: string[];
  className?: string;
  strokeClassName?: string;
  duration?: number;
  delay?: number;
  strokeWidth?: number;
  width?: number;
  height?: number;
  fontSize?: number;
  ease?: "linear" | "easeIn" | "easeOut" | "easeInOut";
  /** Fill the letters in once the stroke has been drawn. */
  fillAfter?: boolean;
  onComplete?: () => void;
}

export function HandwritingSvg({
  path: pathProp,
  text,
  fontUrls = DEFAULT_FONT_URLS,
  className,
  strokeClassName,
  duration = 2,
  delay = 0.5,
  strokeWidth = 2,
  width = 100,
  height = 100,
  fontSize = 48,
  ease = "easeInOut",
  fillAfter = false,
  onComplete,
}: HandwritingSvgProps) {
  const reduce = useReducedMotion();
  const [path, setPath] = useState<string | null>(pathProp ?? null);
  const [strokes, setStrokes] = useState<Stroke[] | null>(null);
  const [viewBox, setViewBox] = useState(`0 0 ${width} ${height}`);
  const [failed, setFailed] = useState(false);
  const urlsKey = fontUrls.join("|");

  useEffect(() => {
    if (!text || pathProp) {
      setStrokes(null);
      setPath(pathProp ?? null);
      setViewBox(`0 0 ${width} ${height}`);
      return;
    }
    let cancelled = false;
    setFailed(false);
    Promise.all(urlsKey.split("|").map(loadFont))
      .then((fonts) => {
        if (cancelled) return;
        const { path: p, missing } = buildTextPath(fonts, text, fontSize);
        if (missing > 0) throw new Error("missing glyphs");
        const bbox = p.getBoundingBox();
        const pad = Math.max(4, strokeWidth * 2);
        const vx = Math.floor(bbox.x1) - pad;
        const vy = Math.floor(bbox.y1) - pad;
        const vw = Math.ceil(bbox.x2 - bbox.x1) + pad * 2;
        const vh = Math.ceil(bbox.y2 - bbox.y1) + pad * 2;
        setViewBox(`${vx} ${vy} ${vw} ${vh}`);
        setStrokes(splitStrokes(p));
        setPath(p.toPathData(2));
      })
      .catch(() => {
        if (!cancelled) {
          setPath(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [text, urlsKey, pathProp, fontSize, width, height, strokeWidth]);

  useEffect(() => {
    if (failed) onComplete?.();
  }, [failed, onComplete]);

  const label = text ?? undefined;

  // Font unavailable: show the words plainly rather than an error in the UI.
  if (failed) {
    return (
      <span
        className={cn("inline-block font-[family-name:var(--font-hand)]", className)}
        style={{ fontSize }}
      >
        {text}
      </span>
    );
  }

  if (!path) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      />
    );
  }

  const svgViewBox = pathProp ? `0 0 ${width} ${height}` : viewBox;

  return (
    <svg
      width={width}
      height={height}
      viewBox={svgViewBox}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {(strokes ?? [{ d: path, length: 1 }]).map((stroke, k, all) => {
        const total = all.reduce((sum, x) => sum + x.length, 0);
        const before = all.slice(0, k).reduce((sum, x) => sum + x.length, 0);
        const share = stroke.length / total;
        const last = k === all.length - 1;
        return (
          <motion.path
            key={k}
            d={stroke.d}
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={strokeClassName}
            initial={reduce ? false : { pathLength: 0, fillOpacity: 0, opacity: 0 }}
            animate={{ pathLength: 1, fillOpacity: fillAfter ? 1 : 0, opacity: 1 }}
            transition={
              reduce
                ? { duration: 0 }
                : {
                    pathLength: { delay: delay + duration * (before / total), duration: Math.max(0.05, duration * share), ease },
                    // hidden until its turn, so round caps do not leave dots where later strokes start
                    opacity: { delay: delay + duration * (before / total), duration: 0.01 },
                    fillOpacity: { delay: delay + duration, duration: 0.6, ease: "easeOut" },
                  }
            }
            onAnimationComplete={last ? () => onComplete?.() : undefined}
          />
        );
      })}
    </svg>
  );
}

export default HandwritingSvg;

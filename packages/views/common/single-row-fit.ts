"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Fit calculator for a single-row toolbar that collapses its tail into a
 * trailing trigger (the view bar; reusable for any "N chips + overflow
 * menu" strip).
 *
 * The caller renders every candidate twice: once for real (slice to
 * `fitCount`) and once inside a hidden mirror row attached to
 * `measureRef` (absolutely positioned, `visibility: hidden`, same
 * classes). Natural widths are read off the mirror, so the fit answer
 * never depends on what is currently mounted for real — no feedback
 * loop between measurement and rendering.
 *
 * Rules:
 * - If everything fits with no trigger at all, `fitCount` = item count.
 * - Otherwise the longest prefix that fits alongside `reserve` px of
 *   trigger wins.
 *
 * Remeasures on container resize (ResizeObserver) and after every
 * commit (labels/items change the mirror); state only updates when the
 * answer actually changes, so the extra passes are free.
 */
export function useSingleRowFit({
  count,
  gap,
  reserve,
}: {
  /** Number of candidate items (mirror children must match). */
  count: number;
  /** Horizontal gap between items in px (the container's `gap`). */
  gap: number;
  /** Width in px to hold back for the overflow trigger. */
  reserve: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [fitCount, setFitCount] = useState(count);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    const mirror = measureRef.current;
    if (!container || !mirror) return;
    const available = container.clientWidth;
    const widths = Array.from(mirror.children).map(
      (child) => (child as HTMLElement).offsetWidth,
    );

    let total = 0;
    for (let i = 0; i < widths.length; i++) {
      total += widths[i]! + (i > 0 ? gap : 0);
    }
    let next: number;
    if (total <= available) {
      next = widths.length;
    } else {
      let used = 0;
      let fit = 0;
      for (let i = 0; i < widths.length; i++) {
        const withItem = used + (i > 0 ? gap : 0) + widths[i]!;
        if (withItem + (fit > 0 ? gap : 0) + reserve > available) break;
        used = withItem;
        fit = i + 1;
      }
      next = fit;
    }
    setFitCount((current) => (current === next ? current : next));
  }, [gap, reserve]);

  // After every commit: the mirror just re-rendered with current labels.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate every-commit measure; the setState inside is change-guarded
  useLayoutEffect(() => {
    recompute();
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => recompute());
    observer.observe(container);
    return () => observer.disconnect();
  }, [recompute]);

  // Never report more than exists (items can shrink between renders).
  return { containerRef, measureRef, fitCount: Math.min(fitCount, count) };
}

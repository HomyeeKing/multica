import { useCallback, useEffect, useRef } from "react";

/** Threshold (px) that distinguishes a click from a pan drag. Mirrors the
 * board's dnd-kit PointerSensor `activationConstraint: { distance: 5 }` so a
 * blank-area press and a card press feel identical up to the moment one is
 * recognized as a drag. */
const PAN_ACTIVATION_DISTANCE = 5;

const INTERACTIVE_SELECTOR =
  "[data-board-card], a, button, input, textarea, select, [role='button'], [contenteditable='true']";

/**
 * Blank-area left-drag panning for a horizontally scrollable board (#6700,
 * Trello/Linear pattern): pressing the LEFT mouse button on empty board
 * background and dragging pans the board horizontally — the page follows the
 * cursor. Dragging a card still moves the card (dnd-kit); this hook stays out
 * of the way because it never activates when the gesture starts on a card or
 * any interactive element.
 *
 * Design notes:
 *   - Pointer Events + pointer capture, so the drag keeps tracking even when
 *     the cursor leaves the element or the window.
 *   - Left button only (`event.button === 0`). Right/middle are untouched, so
 *     the native context menu is never suppressed and the earlier
 *     `mousedown → contextmenu → mousemove` ordering problem cannot occur.
 *   - Activation is gated on a ~5px move so a plain click is not swallowed.
 *   - Horizontal axis only: `deltaY` is never read, `scrollTop` never written.
 *     `scrollLeft` is clamped to `[0, scrollWidth - clientWidth]` so reaching an
 *     edge stops cleanly instead of bouncing back.
 *   - Native text selection is disabled while panning (`user-select: none` +
 *     range clear), so the drag neither highlights column text nor lets the
 *     selection auto-scroll fight the pan at the left edge.
 *   - Cleanup on `pointerup` / `pointercancel` / `lostpointercapture` and
 *     window `blur`, plus a `buttons` check on move, so a lost release cannot
 *     leave the board stuck in a panning state.
 *
 * Returns props to spread onto the scroll container.
 */
export function useBoardDragPan<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  // Pointer id of the active/pending gesture, or null when idle.
  const pointerIdRef = useRef<number | null>(null);
  // True once the ~5px threshold is crossed and we are actually panning.
  const activeRef = useRef(false);
  const startXRef = useRef(0);
  const lastXRef = useRef(0);
  const scrollStartRef = useRef(0);

  const reset = useCallback(() => {
    const el = ref.current;
    if (el && pointerIdRef.current !== null) {
      // releasePointerCapture throws if the capture was already lost; ignore.
      try {
        el.releasePointerCapture(pointerIdRef.current);
      } catch {
        /* capture already released */
      }
    }
    pointerIdRef.current = null;
    activeRef.current = false;
    if (el) {
      el.style.removeProperty("cursor");
      // Restore text selection once the gesture ends.
      el.style.removeProperty("user-select");
      el.style.removeProperty("-webkit-user-select");
    }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<T>) => {
    // Left button only. `button === 0` covers mouse-left and the primary
    // touch/pen contact.
    if (event.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    // Ignore gestures that begin on a card or interactive control — those
    // belong to dnd-kit / links / form fields.
    const target = event.target as Element | null;
    if (target && target.closest(INTERACTIVE_SELECTOR)) return;

    pointerIdRef.current = event.pointerId;
    activeRef.current = false;
    startXRef.current = event.clientX;
    lastXRef.current = event.clientX;
    scrollStartRef.current = el.scrollLeft;
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    if (pointerIdRef.current === null || event.pointerId !== pointerIdRef.current) return;
    const el = ref.current;
    if (!el) return;

    // The primary button was released somewhere we didn't hear about (window
    // blur, drag out of the document). buttons bit 0 is the left button.
    if ((event.buttons & 1) === 0) {
      reset();
      return;
    }

    if (!activeRef.current) {
      if (Math.abs(event.clientX - startXRef.current) < PAN_ACTIVATION_DISTANCE) return;
      // Cross the threshold: begin panning, capture the pointer, show grab.
      activeRef.current = true;
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        /* capture unsupported/failed; drag still works via window fallbacks */
      }
      el.style.cursor = "grabbing";
      // Suppress native text selection for the duration of the pan. Without
      // this the drag selects the column/card text above; the selection's
      // auto-scroll then fights our scrollLeft and yanks the board back toward
      // the anchor when we reach the left edge (the "snaps back" bug).
      el.style.userSelect = "none";
      el.style.setProperty("-webkit-user-select", "none");
    }

    // Clear any selection that the browser started before user-select took
    // effect (the range created between pointerdown and activation).
    const selection =
      typeof window !== "undefined" ? window.getSelection?.() : null;
    if (selection && !selection.isCollapsed) selection.removeAllRanges();

    // Horizontal axis only. Clamp to the scrollable range so hitting an edge
    // simply stops rather than accumulating overscroll.
    const delta = event.clientX - lastXRef.current;
    lastXRef.current = event.clientX;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const next = Math.min(Math.max(el.scrollLeft - delta, 0), Math.max(maxScroll, 0));
    el.scrollLeft = next;
    event.preventDefault();
  }, [reset]);

  const onPointerUp = useCallback((event: React.PointerEvent<T>) => {
    if (event.pointerId !== pointerIdRef.current) return;
    reset();
  }, [reset]);

  useEffect(() => {
    const handleBlur = () => reset();
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [reset]);

  return {
    ref,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onLostPointerCapture: onPointerUp,
  };
}

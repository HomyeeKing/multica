import { useCallback, useEffect, useRef } from "react";

/**
 * Right-mouse-button hold-to-pan for a horizontally scrollable container
 * (HOM-9). While the right button is held down, moving the pointer scrolls the
 * board left/right — the page follows the cursor. Constrained to the horizontal
 * axis only: vertical pointer movement is ignored and never touches
 * `scrollTop`, and no other drag semantics are introduced.
 *
 * The context menu that a right-click would normally raise is suppressed for
 * the interaction so the hold reads as a pan rather than a menu open.
 *
 * Returns props to spread onto the scroll container.
 */
export function useRightButtonPan<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  // True between right-button-down and the following mouseup. Guards the
  // window-level move/up listeners and tells the contextmenu handler to eat the
  // menu that fires at the end of the gesture.
  const panningRef = useRef(false);
  // Whether the pointer actually moved during the hold. A stationary
  // right-click (moved === false) should keep its context menu.
  const movedRef = useRef(false);
  const lastXRef = useRef(0);

  const onMouseDown = useCallback((event: React.MouseEvent<T>) => {
    // Right button only (button === 2). Left/middle keep their existing
    // behavior (card drag, native scroll).
    if (event.button !== 2) return;
    const el = ref.current;
    if (!el) return;
    panningRef.current = true;
    movedRef.current = false;
    lastXRef.current = event.clientX;
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!panningRef.current) return;
      const el = ref.current;
      if (!el) return;
      // Horizontal axis only — deltaY is intentionally never read.
      const deltaX = event.clientX - lastXRef.current;
      if (deltaX !== 0) {
        movedRef.current = true;
        lastXRef.current = event.clientX;
        el.scrollLeft -= deltaX;
      }
      event.preventDefault();
    };

    const handleUp = (event: MouseEvent) => {
      if (!panningRef.current) return;
      if (event.button !== 2) return;
      panningRef.current = false;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const onContextMenu = useCallback((event: React.MouseEvent<T>) => {
    // Suppress the context menu only when the right button was actually used to
    // pan; a plain right-click that never moved keeps its menu.
    if (movedRef.current) {
      event.preventDefault();
      movedRef.current = false;
    }
  }, []);

  return { ref, onMouseDown, onContextMenu };
}

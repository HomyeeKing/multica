/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useRightButtonPan } from "./use-right-button-pan";

function Harness() {
  const pan = useRightButtonPan<HTMLDivElement>();
  return (
    <div
      data-testid="scroller"
      ref={pan.ref}
      onMouseDown={pan.onMouseDown}
      onContextMenu={pan.onContextMenu}
    />
  );
}

function mouseMove(clientX: number, clientY: number) {
  return new MouseEvent("mousemove", { clientX, clientY, bubbles: true });
}

describe("useRightButtonPan", () => {
  afterEach(cleanup);

  it("pans horizontally while the right button is held", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    // jsdom doesn't lay out; scrollLeft is a plain settable number here.
    el.scrollLeft = 100;

    fireEvent.mouseDown(el, { button: 2, clientX: 200, clientY: 50 });
    window.dispatchEvent(mouseMove(160, 50)); // moved left 40 -> scroll right
    expect(el.scrollLeft).toBe(140);
    window.dispatchEvent(mouseMove(180, 50)); // moved right 20 -> scroll left
    expect(el.scrollLeft).toBe(120);

    fireEvent.mouseUp(el, { button: 2 });
    // After release, further moves are ignored.
    window.dispatchEvent(mouseMove(300, 50));
    expect(el.scrollLeft).toBe(120);
  });

  it("ignores vertical movement (horizontal-only)", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    el.scrollLeft = 50;
    const before = el.scrollTop;

    fireEvent.mouseDown(el, { button: 2, clientX: 100, clientY: 100 });
    window.dispatchEvent(mouseMove(100, 300)); // pure vertical
    expect(el.scrollLeft).toBe(50);
    expect(el.scrollTop).toBe(before);
  });

  it("does not pan for the left button", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    el.scrollLeft = 10;

    fireEvent.mouseDown(el, { button: 0, clientX: 200, clientY: 50 });
    window.dispatchEvent(mouseMove(120, 50));
    expect(el.scrollLeft).toBe(10);
  });

  it("suppresses the context menu after a pan but keeps it for a stationary right-click", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    el.scrollLeft = 100;

    // Panned: menu suppressed.
    fireEvent.mouseDown(el, { button: 2, clientX: 200, clientY: 50 });
    window.dispatchEvent(mouseMove(150, 50));
    fireEvent.mouseUp(el, { button: 2 });
    const panned = fireEvent.contextMenu(el);
    expect(panned).toBe(false); // preventDefault was called

    // Stationary: menu preserved.
    fireEvent.mouseDown(el, { button: 2, clientX: 200, clientY: 50 });
    fireEvent.mouseUp(el, { button: 2 });
    const stationary = fireEvent.contextMenu(el);
    expect(stationary).toBe(true);
  });
});

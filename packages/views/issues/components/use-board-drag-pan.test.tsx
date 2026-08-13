/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useBoardDragPan } from "./use-board-drag-pan";

function Harness() {
  const pan = useBoardDragPan<HTMLDivElement>();
  return (
    <div
      data-testid="scroller"
      ref={pan.ref}
      onPointerDown={pan.onPointerDown}
      onPointerMove={pan.onPointerMove}
      onPointerUp={pan.onPointerUp}
      onPointerCancel={pan.onPointerCancel}
      onLostPointerCapture={pan.onLostPointerCapture}
    >
      <div data-testid="blank" style={{ width: 10, height: 10 }} />
      <div data-board-card="" data-testid="card">
        <span data-testid="card-child" />
      </div>
    </div>
  );
}

// jsdom lacks pointer-capture methods; stub them so the hook doesn't throw.
function stubCapture(el: HTMLElement) {
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
}

function down(target: Element, x: number, button = 0) {
  fireEvent.pointerDown(target, { button, clientX: x, clientY: 50, pointerId: 1 });
}
// `buttons: 1` = left button held — the real browser value during a left drag.
function move(target: Element, x: number, buttons = 1) {
  fireEvent.pointerMove(target, { clientX: x, clientY: 50, pointerId: 1, buttons });
}
function up(target: Element) {
  fireEvent.pointerUp(target, { clientX: 0, clientY: 50, pointerId: 1 });
}

describe("useBoardDragPan", () => {
  afterEach(cleanup);

  it("pans horizontally on a left drag from blank background (real event order)", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    stubCapture(el);
    el.scrollLeft = 100;

    // pointerdown → move past 5px threshold → follow cursor → up
    down(getByTestId("blank"), 200);
    move(el, 208); // 8px > threshold: activates; delta from last (200) = 8
    expect(el.scrollLeft).toBe(92); // 100 - 8
    move(el, 188); // moved right 20 -> scroll left
    expect(el.scrollLeft).toBe(112);

    up(el);
    move(el, 400); // after release: ignored
    expect(el.scrollLeft).toBe(112);
  });

  it("does not activate before the ~5px threshold (plain click)", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    stubCapture(el);
    el.scrollLeft = 50;

    down(getByTestId("blank"), 200);
    move(el, 203); // 3px < 5px threshold
    expect(el.scrollLeft).toBe(50);
  });

  it("ignores drags that start on a card (dnd-kit keeps ownership)", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    stubCapture(el);
    el.scrollLeft = 30;

    down(getByTestId("card-child"), 200); // starts inside [data-board-card]
    move(el, 260);
    expect(el.scrollLeft).toBe(30); // never panned, card sorting untouched
  });

  it("ignores the right button entirely (context menu path untouched)", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    stubCapture(el);
    el.scrollLeft = 40;

    down(getByTestId("blank"), 200, 2); // right button
    move(el, 260, 2);
    expect(el.scrollLeft).toBe(40);
  });

  it("does not stay stuck when the release event is lost", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    stubCapture(el);
    el.scrollLeft = 100;

    down(getByTestId("blank"), 200);
    move(el, 220); // activates, pans
    expect(el.scrollLeft).toBe(80);

    // Release happened off-window: no pointerup fired. Next move reports the
    // button no longer held (buttons === 0) and must NOT keep panning.
    move(el, 400, 0);
    expect(el.scrollLeft).toBe(80);
    move(el, 500, 0);
    expect(el.scrollLeft).toBe(80);
  });

  it("only reads the horizontal axis (scrollTop untouched)", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroller");
    stubCapture(el);
    el.scrollLeft = 50;
    const topBefore = el.scrollTop;

    down(getByTestId("blank"), 200);
    move(el, 220); // activate
    fireEvent.pointerMove(el, { clientX: 220, clientY: 400, pointerId: 1, buttons: 1 });
    expect(el.scrollTop).toBe(topBefore);
  });
});

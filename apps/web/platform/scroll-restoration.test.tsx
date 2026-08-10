// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRestoredScrollOffset } from "@multica/views/platform";
import { WebScrollRestorationProvider } from "./scroll-restoration";

function ScrollProbe({ containerKey }: { containerKey: string }) {
  const restored = useRestoredScrollOffset(containerKey);
  return <output data-testid="restored">{restored ?? "none"}</output>;
}

/** Dispatch a real scroll event from a marked container element. */
function scrollContainer(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollTop", { configurable: true, value: top });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: 2000,
  });
  el.dispatchEvent(new Event("scroll", { bubbles: false }));
}

describe("WebScrollRestorationProvider", () => {
  it("serves a captured container offset back for the same pathname", () => {
    const view = render(
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="main" data-testid="container" />
        <ScrollProbe containerKey="main" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("container"), 480);

    // Remount — the same pull the view performs after navigating back.
    view.rerender(
      <WebScrollRestorationProvider>
        <ScrollProbe containerKey="main" />
      </WebScrollRestorationProvider>,
    );
    expect(screen.getByTestId("restored").textContent).toBe("480");
  });

  it("clears the saved offset when the container scrolls back to the top", () => {
    const view = render(
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="cleared" data-testid="container" />
        <ScrollProbe containerKey="cleared" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("container"), 480);
    scrollContainer(screen.getByTestId("container"), 0);

    view.rerender(
      <WebScrollRestorationProvider>
        <ScrollProbe containerKey="cleared" />
      </WebScrollRestorationProvider>,
    );
    expect(screen.getByTestId("restored").textContent).toBe("none");
  });

  it("ignores scrolls from unmarked elements", () => {
    render(
      <WebScrollRestorationProvider>
        <div data-testid="plain" />
        <ScrollProbe containerKey="plain" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("plain"), 480);
    expect(screen.getByTestId("restored").textContent).toBe("none");
  });
});

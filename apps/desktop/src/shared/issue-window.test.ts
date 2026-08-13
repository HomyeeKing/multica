import { describe, expect, it } from "vitest";
import {
  encodeIssueWindowArgument,
  issueWindowKey,
  parseIssueWindowPath,
  parseIssueWindowRequest,
  readDesktopWindowContext,
} from "./issue-window";

describe("issue window request", () => {
  it("accepts and canonicalizes a workspace-scoped issue detail path", () => {
    expect(
      parseIssueWindowRequest({
        path: "/acme/issues/issue-123?comment=comment-1#activity",
        title: "  MUL-1: Fix tabs  ",
      }),
    ).toEqual({
      kind: "issue",
      path: "/acme/issues/issue-123?comment=comment-1#activity",
      title: "MUL-1: Fix tabs",
      workspaceSlug: "acme",
      issueId: "issue-123",
    });
  });

  it.each([
    "/acme/issues",
    "/acme/projects/project-1",
    "/acme/issues/issue-1/attachments",
    "https://example.com/acme/issues/issue-1",
    "//example.com/acme/issues/issue-1",
    "/acme/issues/issue%2F1",
    "/UPPERCASE/issues/issue-1",
  ])("rejects non-issue or unsafe paths: %s", (path) => {
    expect(parseIssueWindowPath(path)).toBeNull();
  });

  it("uses a safe fallback title and bounds renderer-controlled titles", () => {
    expect(
      parseIssueWindowRequest({ path: "/acme/issues/issue-1", title: "  " }),
    ).toMatchObject({ title: "Issue" });
    expect(
      parseIssueWindowRequest({
        path: "/acme/issues/issue-1",
        title: "x".repeat(400),
      })?.title,
    ).toHaveLength(256);
  });

  it("round-trips a validated request through Electron additionalArguments", () => {
    const argument = encodeIssueWindowArgument({
      path: "/acme/issues/issue-1",
      title: "MUL-1: Fix tabs",
    });

    expect(readDesktopWindowContext(["electron", argument])).toEqual({
      kind: "issue",
      path: "/acme/issues/issue-1",
      title: "MUL-1: Fix tabs",
      workspaceSlug: "acme",
      issueId: "issue-1",
    });
  });

  it("falls back to the main window for malformed launch arguments", () => {
    expect(
      readDesktopWindowContext(["electron", "--multica-issue-window=%7Bbad"]),
    ).toEqual({ kind: "main" });
  });
});

describe("issueWindowKey", () => {
  it("keys by workspace + issue so the same issue dedupes to one window", () => {
    const a = parseIssueWindowRequest({
      path: "/acme/issues/issue-1?comment=comment-1#activity",
      title: "MUL-1",
    })!;
    const b = parseIssueWindowRequest({
      path: "/acme/issues/issue-1?comment=comment-9",
      title: "MUL-1",
    })!;
    // Same issue, different comment anchor → same key (reuse the window).
    expect(issueWindowKey(a)).toBe(issueWindowKey(b));
  });

  it("distinguishes different issues and different workspaces", () => {
    const acme1 = parseIssueWindowRequest({
      path: "/acme/issues/issue-1",
      title: "x",
    })!;
    const acme2 = parseIssueWindowRequest({
      path: "/acme/issues/issue-2",
      title: "x",
    })!;
    const butter1 = parseIssueWindowRequest({
      path: "/butter/issues/issue-1",
      title: "x",
    })!;
    expect(issueWindowKey(acme1)).not.toBe(issueWindowKey(acme2));
    expect(issueWindowKey(acme1)).not.toBe(issueWindowKey(butter1));
  });
});

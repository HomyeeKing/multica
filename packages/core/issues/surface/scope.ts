import type { IssueAssigneeType } from "../../types";

export type WorkspaceIssueActorKind = "all" | "members" | "agents";

export type IssueScope =
  | { type: "workspace"; actorKind?: WorkspaceIssueActorKind }
  | {
      type: "my";
      relation: "all" | "assigned" | "created" | "involved";
      userId: string;
    }
  | { type: "project"; projectId: string; actorKind?: WorkspaceIssueActorKind }
  | {
      type: "actor";
      actorType: Extract<IssueAssigneeType, "member" | "agent">;
      actorId: string;
      relation: "assigned" | "created";
    }
  | { type: "team"; teamId: string };

export class UnsupportedIssueScopeError extends Error {
  constructor(scope: IssueScope, operation: string) {
    super(`Issue scope "${issueScopeKey(scope)}" is not supported for ${operation}.`);
    this.name = "UnsupportedIssueScopeError";
  }
}

export function issueScopeKey(scope: IssueScope): string {
  switch (scope.type) {
    case "workspace":
      return `workspace:${scope.actorKind ?? "all"}`;
    case "my":
      return `my:${scope.userId}:${scope.relation}`;
    case "project":
      // The unrestricted tab keeps the historical key so existing persisted
      // display state survives; Members/Agents get their own key (and thus
      // their own per-tab display state), matching the workspace tabs.
      return scope.actorKind === "members" || scope.actorKind === "agents"
        ? `project:${scope.projectId}:${scope.actorKind}`
        : `project:${scope.projectId}`;
    case "actor":
      return `actor:${scope.actorType}:${scope.actorId}:${scope.relation}`;
    case "team":
      return `team:${scope.teamId}`;
  }
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CreateIssueViewRequest } from "../api/schemas";
import { issueViewKeys } from "./queries";

/** Create is a confirmed flow (dialog + toast) — no optimism, await then
 *  invalidate so every surface's selector refetches. */
export function useCreateIssueView(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateIssueViewRequest) => api.createIssueView(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: issueViewKeys.all(wsId) });
    },
  });
}

export interface UpdateIssueViewInput {
  id: string;
  name?: string;
  visibility?: "private" | "workspace";
  scope_variant?: string | null;
  query?: Record<string, unknown>;
  display?: Record<string, unknown>;
  expected_revision: number;
}

/** Optimistic-free by design: edits are a confirmed dialog flow and the 409
 *  conflict path (someone else edited first) needs the server's answer. */
export function useUpdateIssueView(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateIssueViewInput) =>
      api.updateIssueView(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: issueViewKeys.all(wsId) });
    },
  });
}

export function useDeleteIssueView(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteIssueView(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: issueViewKeys.all(wsId) });
    },
  });
}

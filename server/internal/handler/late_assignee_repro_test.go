package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLateAssignedAgentReceivesPlainReplyToPreAssignmentComment(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	agentID := createHandlerTestAgent(t, "Late Assignee Agent", nil)
	issueID := createUnassignedLateAssigneeIssue(t, "late agent assignee repro")

	rootID := postLateAssigneeMemberComment(t, issueID, map[string]any{
		"content": "plain comment before assignment",
	})
	if n := countQueuedCommentTriggerTasks(t, issueID, agentID); n != 0 {
		t.Fatalf("unassigned root comment queued tasks = %d, want 0", n)
	}

	assignLateAssignee(t, issueID, "agent", agentID)
	// Assignment can start its own run. Remove it so only the subsequent reply
	// can satisfy the assertion below.
	testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)

	postLateAssigneeMemberComment(t, issueID, map[string]any{
		"content":   "plain reply after assignment",
		"parent_id": rootID,
	})
	if n := countQueuedCommentTriggerTasks(t, issueID, agentID); n != 1 {
		t.Fatalf("post-assignment reply queued tasks = %d, want 1", n)
	}
}

func TestLateAssignedSquadReceivesPlainReplyToPreAssignmentComment(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	leaderID := createHandlerTestAgent(t, "Late Squad Leader", nil)
	squadID := createCommentTriggerPreviewSquad(t, "Late Squad", leaderID)
	issueID := createUnassignedLateAssigneeIssue(t, "late squad assignee repro")

	rootID := postLateAssigneeMemberComment(t, issueID, map[string]any{
		"content": "plain comment before assignment",
	})
	if n := countQueuedCommentTriggerTasks(t, issueID, leaderID); n != 0 {
		t.Fatalf("unassigned root comment queued leader tasks = %d, want 0", n)
	}

	assignLateAssignee(t, issueID, "squad", squadID)
	testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)

	postLateAssigneeMemberComment(t, issueID, map[string]any{
		"content":   "plain reply after assignment",
		"parent_id": rootID,
	})
	if n := countQueuedCommentTriggerTasks(t, issueID, leaderID); n != 1 {
		t.Fatalf("post-assignment reply queued leader tasks = %d, want 1", n)
	}
}

func createUnassignedLateAssigneeIssue(t *testing.T, title string) string {
	t.Helper()
	ctx := context.Background()
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, creator_type, creator_id, title)
		VALUES ($1, 'member', $2, $3)
		RETURNING id
	`, testWorkspaceID, testUserID, title).Scan(&issueID); err != nil {
		t.Fatalf("create unassigned issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM comment WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
	})
	return issueID
}

func postLateAssigneeMemberComment(t *testing.T, issueID string, body map[string]any) string {
	t.Helper()
	w := httptest.NewRecorder()
	r := newRequest("POST", "/api/issues/"+issueID+"/comments", body)
	r = withURLParam(r, "id", issueID)
	testHandler.CreateComment(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateComment: %d %s", w.Code, w.Body.String())
	}
	var resp CommentResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode comment response: %v", err)
	}
	return resp.ID
}

func assignLateAssignee(t *testing.T, issueID, assigneeType, assigneeID string) {
	t.Helper()
	w := httptest.NewRecorder()
	r := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": assigneeType,
		"assignee_id":   assigneeID,
	})
	r = withURLParam(r, "id", issueID)
	testHandler.UpdateIssue(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue assign: %d %s", w.Code, w.Body.String())
	}
}

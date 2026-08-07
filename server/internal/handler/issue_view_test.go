package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/pkg/featureflag"
)

// enableIssueViews flips the saved_issue_views_v1 flag on for the duration of
// one test and restores the previous (nil = everything default-off) service.
func enableIssueViews(t *testing.T) {
	t.Helper()
	prev := testHandler.FeatureFlags
	provider := featureflag.NewStaticProvider()
	provider.Set(featureflags.SavedIssueViews, featureflag.Rule{Default: true})
	testHandler.FeatureFlags = featureflag.NewService(provider)
	t.Cleanup(func() { testHandler.FeatureFlags = prev })
}

func createIssueViewForTest(t *testing.T, body map[string]any) (IssueViewResponse, int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issue-views", body)
	testHandler.CreateIssueView(w, req)
	var view IssueViewResponse
	if w.Code == http.StatusCreated {
		json.NewDecoder(w.Body).Decode(&view)
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_view WHERE id = $1`, view.ID)
		})
	}
	return view, w.Code, w.Body.String()
}

func TestIssueViewsGatedByFlag(t *testing.T) {
	// No flag service configured → the feature does not exist: 404.
	w := httptest.NewRecorder()
	testHandler.ListIssueViews(w, newRequest("GET", "/api/issue-views?scope_type=workspace", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 with flag off, got %d", w.Code)
	}
}

func TestCreateAndListIssueView(t *testing.T) {
	enableIssueViews(t)

	view, code, body := createIssueViewForTest(t, map[string]any{
		"name":       "Needs review",
		"scope_type": "workspace",
		"visibility": "workspace",
		"query":      map[string]any{"statusFilters": []string{"in_review"}},
		"display":    map[string]any{"viewMode": "board"},
	})
	if code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d: %s", code, body)
	}
	if view.Revision != 1 || view.DefinitionVersion != 1 {
		t.Fatalf("expected revision=1 definition_version=1, got %d/%d", view.Revision, view.DefinitionVersion)
	}
	if view.Visibility != "workspace" {
		t.Fatalf("expected workspace visibility, got %s", view.Visibility)
	}

	w := httptest.NewRecorder()
	testHandler.ListIssueViews(w, newRequest("GET", "/api/issue-views?scope_type=workspace", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var views []IssueViewResponse
	json.NewDecoder(w.Body).Decode(&views)
	found := false
	for _, v := range views {
		if v.ID == view.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("created view %s missing from list", view.ID)
	}
}

func TestMyIssueViewForcedPrivate(t *testing.T) {
	enableIssueViews(t)

	view, code, body := createIssueViewForTest(t, map[string]any{
		"name":          "My assigned",
		"scope_type":    "my",
		"scope_variant": "assigned",
		"visibility":    "workspace", // must be overridden
		"query":         map[string]any{},
	})
	if code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", code, body)
	}
	if view.Visibility != "private" {
		t.Fatalf("my view must be forced private, got %s", view.Visibility)
	}
	if view.ScopeVariant == nil || *view.ScopeVariant != "assigned" {
		t.Fatalf("scope_variant not persisted: %+v", view.ScopeVariant)
	}
}

func TestIssueViewPrivateInvisibleToOthers(t *testing.T) {
	enableIssueViews(t)

	view, code, body := createIssueViewForTest(t, map[string]any{
		"name":       "Mine only",
		"scope_type": "workspace",
		"visibility": "private",
		"query":      map[string]any{},
	})
	if code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", code, body)
	}

	// A second member of the same workspace must neither list nor fetch it.
	otherID := createSecondWorkspaceMember(t)

	w := httptest.NewRecorder()
	req := newRequest("GET", "/api/issue-views?scope_type=workspace", nil)
	req.Header.Set("X-User-ID", otherID)
	testHandler.ListIssueViews(w, req)
	var views []IssueViewResponse
	json.NewDecoder(w.Body).Decode(&views)
	for _, v := range views {
		if v.ID == view.ID {
			t.Fatalf("private view leaked into another member's list")
		}
	}

	w = httptest.NewRecorder()
	req = newRequest("GET", "/api/issue-views/"+view.ID, nil)
	req.Header.Set("X-User-ID", otherID)
	req = withURLParam(req, "id", view.ID)
	testHandler.GetIssueViewByID(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for foreign private view, got %d", w.Code)
	}
}

func TestUpdateIssueViewRevisionConflict(t *testing.T) {
	enableIssueViews(t)

	view, code, body := createIssueViewForTest(t, map[string]any{
		"name":       "Conflict target",
		"scope_type": "workspace",
		"query":      map[string]any{},
	})
	if code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", code, body)
	}

	patch := func(rev int32, name string) int {
		w := httptest.NewRecorder()
		req := newRequest("PATCH", "/api/issue-views/"+view.ID, map[string]any{
			"name":              name,
			"expected_revision": rev,
		})
		req = withURLParam(req, "id", view.ID)
		testHandler.UpdateIssueView(w, req)
		return w.Code
	}

	if got := patch(1, "First rename"); got != http.StatusOK {
		t.Fatalf("first patch: expected 200, got %d", got)
	}
	// Same expected_revision again → the row is at revision 2 now.
	if got := patch(1, "Stale rename"); got != http.StatusConflict {
		t.Fatalf("stale patch: expected 409, got %d", got)
	}
	if got := patch(2, "Second rename"); got != http.StatusOK {
		t.Fatalf("fresh patch: expected 200, got %d", got)
	}
}

// createSecondWorkspaceMember inserts another user + membership in the test
// workspace and returns the user id.
func createSecondWorkspaceMember(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	var userID string
	email := fmt.Sprintf("issue-view-other-%s@test.local", t.Name())
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (email, name) VALUES ($1, 'View Other')
		ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
		RETURNING id
	`, email).Scan(&userID); err != nil {
		t.Fatalf("create second user: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'member')
		ON CONFLICT DO NOTHING
	`, testWorkspaceID, userID); err != nil {
		t.Fatalf("create second membership: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM member WHERE workspace_id = $1 AND user_id = $2`, testWorkspaceID, userID)
		testPool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, userID)
	})
	return userID
}

func TestWorkspaceIssueViewVariant(t *testing.T) {
	enableIssueViews(t)

	// Save from the Agents tab: variant persists.
	view, code, body := createIssueViewForTest(t, map[string]any{
		"name":          "Agent work",
		"scope_type":    "workspace",
		"scope_variant": "agents",
		"query":         map[string]any{},
	})
	if code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", code, body)
	}
	if view.ScopeVariant == nil || *view.ScopeVariant != "agents" {
		t.Fatalf("workspace variant not persisted: %+v", view.ScopeVariant)
	}

	// "all" normalizes to NULL (no restriction).
	view2, code, body := createIssueViewForTest(t, map[string]any{
		"name":          "Everything",
		"scope_type":    "workspace",
		"scope_variant": "all",
		"query":         map[string]any{},
	})
	if code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", code, body)
	}
	if view2.ScopeVariant != nil {
		t.Fatalf("'all' must normalize to NULL, got %v", *view2.ScopeVariant)
	}

	// My-only variants are rejected on workspace views.
	_, code, _ = createIssueViewForTest(t, map[string]any{
		"name":          "Bad variant",
		"scope_type":    "workspace",
		"scope_variant": "assigned",
		"query":         map[string]any{},
	})
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400 for my-variant on workspace view, got %d", code)
	}

	// Switching the variant via PATCH works; the scope_type stays fixed.
	w := httptest.NewRecorder()
	req := newRequest("PATCH", "/api/issue-views/"+view.ID, map[string]any{
		"scope_variant":     "members",
		"expected_revision": 1,
	})
	req = withURLParam(req, "id", view.ID)
	testHandler.UpdateIssueView(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("patch variant: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var updated IssueViewResponse
	json.NewDecoder(w.Body).Decode(&updated)
	if updated.ScopeVariant == nil || *updated.ScopeVariant != "members" {
		t.Fatalf("variant switch lost: %+v", updated.ScopeVariant)
	}
}

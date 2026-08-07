-- name: CreateIssueView :one
INSERT INTO issue_view (
    workspace_id, owner_id, name, scope_type, scope_id, scope_variant,
    visibility, definition_version, query, display
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: ListIssueViewsForUser :many
-- One surface's selector list: the caller's own views plus workspace-shared
-- ones, for a single (scope_type, scope_id) container. scope_id is NULL for
-- workspace and my scopes, so compare NULL-safely.
SELECT * FROM issue_view
WHERE workspace_id = $1
  AND scope_type = $2
  AND scope_id IS NOT DISTINCT FROM sqlc.narg('scope_id')::uuid
  AND (owner_id = $3 OR visibility = 'workspace')
ORDER BY created_at ASC;

-- name: GetIssueView :one
-- Defense-in-depth: workspace_id is a SQL-layer tenant guard. Authorization
-- (owner vs shared) happens in the handler so unauthorized reads 404.
SELECT * FROM issue_view
WHERE id = $1 AND workspace_id = $2;

-- name: UpdateIssueView :one
-- Optimistic concurrency: the row only updates when the caller's revision
-- matches; zero rows back means either a stale revision (409) or a vanished
-- view (404) — the handler re-reads to tell them apart.
UPDATE issue_view SET
    name = $3,
    visibility = $4,
    scope_variant = $5,
    query = $6,
    display = $7,
    revision = revision + 1,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND revision = $8
RETURNING *;

-- name: DeleteIssueView :one
DELETE FROM issue_view
WHERE id = $1 AND workspace_id = $2
RETURNING id;

-- name: DeleteIssueViewsByProjectScope :exec
-- Project deletion cleanup: called inside DeleteProject's application
-- transaction so project views never outlive their surface.
DELETE FROM issue_view
WHERE workspace_id = $1 AND scope_type = 'project' AND scope_id = $2;

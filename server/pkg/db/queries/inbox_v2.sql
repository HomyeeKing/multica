-- Inbox v2 (route B): inbox_item keeps its role as the event table and gains
-- group columns; inbox_group holds the per-person state the product has always
-- operated on.
--
-- Nothing calls these until the write gate is opened.

-- name: GetInboxV2WriteEnabled :one
-- Read inside the delivery transaction. See migration 274 for why the gate is a
-- row rather than a process-level flag.
--
-- FOR SHARE, not a plain SELECT. A plain read does not conflict with the
-- activation UPDATE, so this sequence is possible: a delivery reads `off`,
-- activation commits and a reconcile pass runs to completion, and only then
-- does the delivery commit its legacy-only row — leaving an unclaimed row
-- behind that the pass it raced has already finished looking for. The share
-- lock makes activation wait for every in-flight delivery, which is what turns
-- "the switch is on" into a boundary rather than a suggestion.
SELECT write_enabled FROM inbox_v2_cutover WHERE id = true FOR SHARE;

-- name: SetInboxV2WriteEnabled :exec
-- Takes the row's exclusive lock, so it blocks behind every delivery currently
-- holding the share lock above and no delivery can straddle the flip.
UPDATE inbox_v2_cutover SET write_enabled = @write_enabled, updated_at = now()
WHERE id = true;

-- name: FindInboxItemByDeliveryKey :one
-- Idempotency probe for a new delivery. Only an optimisation: two concurrent
-- transactions can both miss it, and inbox_item_delivery_key_uidx is what
-- actually decides the winner.
SELECT * FROM inbox_item WHERE delivery_key = @delivery_key;

-- name: AcquireInboxGroup :one
-- Get-or-create the group and hold its row lock for the rest of the
-- transaction. ON CONFLICT DO UPDATE rather than DO NOTHING: DO NOTHING returns
-- no row and takes no lock, leaving the caller to issue a second
-- SELECT ... FOR UPDATE and race between the two. The no-op SET keeps the row
-- unchanged while still locking it.
--
-- This lock is the fixed point in the lock order every write path shares:
-- group first, then its items.
INSERT INTO inbox_group (
    workspace_id, recipient_id, source_kind, source_id, latest_event_at, surfaced_at
) VALUES (
    @workspace_id, @recipient_id, @source_kind, @source_id, @now, @now
)
ON CONFLICT (workspace_id, recipient_id, source_kind, source_id)
DO UPDATE SET updated_at = inbox_group.updated_at
RETURNING *;

-- name: InsertInboxItemForGroup :one
-- The delivery itself. event_seq and created_at are supplied by the caller,
-- which computed them under the group lock it already holds.
--
-- created_at is monotonic within the group: the caller passes
-- max(now, group.latest_event_at + 1us). Two deliveries in the same millisecond,
-- or a node whose clock is behind, would otherwise produce a created_at ordering
-- that disagrees with event_seq — and the legacy endpoints sort by created_at,
-- so the v1 and v2 views would pick different representative rows for the same
-- group.
INSERT INTO inbox_item (
    workspace_id, recipient_type, recipient_id, type, severity, issue_id,
    title, body, actor_type, actor_id, details,
    group_id, event_seq, target_kind, target_id, delivery_key,
    read, archived, created_at
) VALUES (
    @workspace_id, 'member', @recipient_id, @type, @severity, @issue_id,
    @title, @body, @actor_type, @actor_id, @details,
    @group_id, @event_seq, @target_kind, @target_id, @delivery_key,
    false, false, @created_at
)
RETURNING *;

-- name: AdvanceInboxGroupForItem :one
-- Second half of the delivery, same transaction. Clearing archived_at is the
-- "archive is not unsubscribe" rule: a new event pulls an archived group back
-- into the inbox.
UPDATE inbox_group
SET latest_seq      = @event_seq,
    latest_event_id = @event_id,
    latest_event_at = @created_at,
    surfaced_at     = @created_at,
    archived_at     = NULL,
    state_version   = state_version + 1,
    updated_at      = @now
WHERE id = @id
RETURNING *;

-- name: RefreshInboxItemMirror :execrows
-- Push the group's state back onto the legacy booleans every v1 client reads.
--
-- The invariant, in full:
--   archived = the group is archived
--   read     = true for every row EXCEPT the representative one while the group
--              is unread
--
-- Only the representative row goes unread because that is the single row v1
-- clients fold a group down to; marking the whole history unread would make the
-- old raw-row count report a group as N unread items instead of one.
--
-- A dismissed row stays archived whatever the group says. Dismissal and group
-- archive are different facts (see migration 275): deriving `archived` from the
-- group alone would resurrect every retired task_failed row on the next
-- delivery, silently undoing a feature this refactor has to preserve.
--
-- The IS DISTINCT FROM guard is not cosmetic. Without it every delivery rewrites
-- every row of the group, so a busy issue turns one insert into an update of its
-- entire history — and each of those updates is a new row version Postgres has
-- to vacuum.
UPDATE inbox_item i
SET read     = CASE WHEN g.unread AND i.event_seq = g.latest_seq THEN false ELSE true END,
    archived = (g.want_archived OR i.dismissed_at IS NOT NULL)
FROM (
    SELECT id,
           (archived_at IS NOT NULL) AS want_archived,
           (manual_unread OR read_through_seq < latest_seq) AS unread,
           latest_seq
    FROM inbox_group
    WHERE inbox_group.id = @group_id
) g
WHERE i.group_id = g.id
  AND (
        i.read IS DISTINCT FROM (CASE WHEN g.unread AND i.event_seq = g.latest_seq THEN false ELSE true END)
     OR i.archived IS DISTINCT FROM (g.want_archived OR i.dismissed_at IS NOT NULL)
      );

-- name: GetInboxGroupForRecipient :one
-- Every single-group read is scoped by owner rather than trusting a bare id: a
-- UUID arriving from a request is not proof of ownership.
SELECT * FROM inbox_group
WHERE id = @id AND workspace_id = @workspace_id AND recipient_id = @recipient_id;

-- name: RecomputeInboxGroupRepresentative :one
-- Recompute latest_* from the surviving rows, DOWNWARD as well as upward.
--
-- This is why latest_* cannot simply be advanced on insert and left alone.
-- Event-level dismissal still exists: when an issue completes it retires that
-- issue's stale task_failed row, and if that row was the representative the
-- group has to fall back to the newest survivor. read_through_seq is clamped to
-- the new latest so a cursor that had passed the removed event does not sit
-- above the group's own head and report it permanently read.
--
-- Dismissed rows are excluded from the search. A dismissed notification is one
-- the user was deliberately shown the back of; electing it as the row that
-- represents the group would put it straight back in front of them.
-- All three pointers come from ONE survivor row, read once.
--
-- Three independent scalar subqueries let them disagree: the first version of
-- this query filtered dismissed rows out of the seq and the timestamp but not
-- out of the id, so retiring the newest task_failed left latest_seq pointing at
-- the survivor while latest_event_id still pointed at the dismissed row — and
-- with nothing but dismissed rows left, latest_seq went to 0 while
-- latest_event_id stayed non-null. A single CTE makes that class of skew
-- unrepresentable rather than merely fixed.
--
-- No survivor at all is a real state: every row dismissed. latest_event_id goes
-- NULL and latest_seq 0, so the group reads as empty rather than pointing at
-- something the user was shown the back of.
WITH survivor AS (
    SELECT event_seq, id, created_at
    FROM inbox_item
    WHERE group_id = @id AND dismissed_at IS NULL
    ORDER BY event_seq DESC
    LIMIT 1
)
UPDATE inbox_group g
SET latest_seq       = COALESCE((SELECT event_seq FROM survivor), 0),
    latest_event_id  = (SELECT id FROM survivor),
    latest_event_at  = COALESCE((SELECT created_at FROM survivor), g.latest_event_at),
    read_through_seq = LEAST(g.read_through_seq, COALESCE((SELECT event_seq FROM survivor), 0)),
    state_version    = g.state_version + 1,
    updated_at       = @now
WHERE g.id = @id
RETURNING g.*;

-- name: ClaimInboxItemsForSource :execrows
-- Lazy migration: attach this person's unclaimed rows for one source to a group
-- and number them. Must be called with the group row already locked.
--
-- Numbering continues from the group's HIGH-WATER MARK, which the query reads
-- itself rather than taking as a parameter.
--
-- Not latest_seq: that points at the representative row and moves DOWN when a
-- dismissal retires the head, while the dismissed row keeps its number. A gap
-- row claimed after such a dismissal — rollback windows produce them — would be
-- handed a sequence that is still occupied and collide on
-- inbox_item_group_seq_uidx. The high-water mark and the representative are
-- different questions, the same way they are for a new delivery.
--
-- Starting at 1 unconditionally would collide too: the gate opens, a new
-- notification lands on an empty group as event_seq 1, and only afterwards does
-- this person's page load and claim the history.
--
-- The delivery path calls this under the group lock BEFORE allocating its own
-- sequence, which is what keeps the offset zero in practice: history is claimed
-- while the group is still empty, so it numbers 1..M in created_at order and the
-- new event takes M+1. That ordering matters beyond tidiness — the legacy
-- endpoints sort by created_at, so if the sequence disagreed with it, v1 and v2
-- would elect different representative rows for the same group.
--
-- Ordering by (created_at, id): created_at alone is not unique in the legacy
-- data, and an unstable tie-break would make the numbering non-deterministic
-- across a retry.
WITH high_water AS (
    SELECT COALESCE(MAX(event_seq), 0) AS mark FROM inbox_item WHERE group_id = @group_id
),
numbered AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY created_at, id) + (SELECT mark FROM high_water) AS seq
    FROM inbox_item
    WHERE inbox_item.workspace_id = @workspace_id
      AND inbox_item.recipient_type = 'member'
      AND inbox_item.recipient_id = @recipient_id
      AND inbox_item.group_id IS NULL
      AND (
            -- An issue source claims every unclaimed row for that issue.
            (@source_kind::text = 'issue' AND inbox_item.issue_id = @source_id::uuid)
            -- A standalone source is ONE row, addressed by its own id. Folding
            -- all of a person's issue-less rows into one group would merge
            -- unrelated notifications — an autopilot pause and a failed quick
            -- create have nothing to do with each other.
         OR (@source_kind::text = 'standalone' AND inbox_item.id = @source_id::uuid)
          )
)
UPDATE inbox_item i
SET group_id  = @group_id,
    event_seq = numbered.seq
FROM numbered
WHERE i.id = numbered.id;

-- name: ListUnclaimedInboxSources :many
-- The sources a person still has unclaimed rows for. One group is created per
-- row of this result.
--
-- The projection, not a GROUP BY on issue_id: rows with no issue each become
-- their OWN standalone group keyed on the row id. Grouping by issue_id alone
-- would fold every issue-less notification a person has in a workspace into a
-- single group, so an autopilot pause and an unrelated quick-create failure
-- would share one read cursor and one archive state.
SELECT DISTINCT
    workspace_id,
    CASE WHEN issue_id IS NULL THEN 'standalone' ELSE 'issue' END AS source_kind,
    COALESCE(issue_id, id) AS source_id
FROM inbox_item
WHERE recipient_type = 'member'
  AND recipient_id = @recipient_id
  AND group_id IS NULL;

-- name: CountUnclaimedInboxItems :one
-- Budget check for the lazy migration: above the threshold the request returns
-- not_ready and the work moves to the background instead of blocking a page
-- load behind an unbounded scan.
SELECT COUNT(*) FROM inbox_item
WHERE recipient_type = 'member' AND recipient_id = @recipient_id AND group_id IS NULL;

-- name: NextInboxItemSeqForGroup :one
-- The next sequence number for a group. Must be called with the group locked.
--
-- MAX over ALL rows, including dismissed ones — deliberately NOT latest_seq.
-- latest_seq points at the REPRESENTATIVE row, and that pointer moves DOWN when
-- a dismissal retires the head. Allocating from it would then hand the next
-- delivery a number the dismissed row still occupies, and the insert would
-- collide on inbox_item_group_seq_uidx. The high-water mark and the
-- representative are two different questions; conflating them only looks
-- correct until the first dismissal.
SELECT (COALESCE(MAX(event_seq), 0) + 1)::bigint FROM inbox_item WHERE group_id = @group_id;

-- name: SeedInboxGroupCursorForClaimedHistory :one
-- After a lazy claim, seed the cursor from what v1 was already showing.
--
-- The claimed rows are not new: they were sitting in the person's inbox with
-- their own read/archived booleans, and v1's invariant is that at most the
-- representative row is unread. So the honest translation reads that row:
--
--   representative unread in v1  -> cursor one below the head, so v2 agrees
--   representative already read  -> cursor AT the head, nothing resurfaces
--
-- A blanket "latest - 1" would re-announce an already-read history as unread the
-- first time the group materialises, which is the ghost-unread bug this whole
-- refactor exists to kill. Starting at 0 would be worse still. manual_unread is
-- untouched either way: it belongs to the user, not to a migration.
UPDATE inbox_group g
SET read_through_seq = CASE WHEN rep.read THEN g.latest_seq
                            ELSE GREATEST(g.latest_seq - 1, 0) END,
    state_version    = g.state_version + 1,
    updated_at       = @now
FROM (
    SELECT COALESCE(
        (SELECT i.read FROM inbox_item i
         WHERE i.group_id = @id AND i.dismissed_at IS NULL
         ORDER BY i.event_seq DESC LIMIT 1), true) AS read
) rep
WHERE g.id = @id
RETURNING g.*;

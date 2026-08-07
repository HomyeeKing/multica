// Package inboxv2 owns the group/event model behind the Inbox.
//
// The product renders "one row per issue" but the database only ever had "one
// row per event", so the row a user marks read, archives or snoozes has never
// existed as an entity — each of the three clients folded events into it for
// itself. inbox_group is that entity; inbox_item keeps its role as the event
// table and gains the columns that tie the two together.
package inboxv2

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TxStarter matches the interface the other services in this tree use.
type TxStarter interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// SourceKind identifies what a group is about.
type SourceKind string

const (
	// SourceIssue folds everything about one issue into one row per person.
	SourceIssue SourceKind = "issue"
	// SourceStandalone is for notifications with no durable parent — an
	// autopilot pausing, a quick create that failed before an issue existed.
	SourceStandalone SourceKind = "standalone"
)

// uniqueViolation is the SQLSTATE for a unique constraint violation.
const uniqueViolation = "23505"

// Delivery is one notification for one member, in the shape the write path
// needs. Producers already hold every field; the legacy write threw most of the
// structure away into a JSON blob.
type Delivery struct {
	WorkspaceID pgtype.UUID
	RecipientID pgtype.UUID

	SourceKind SourceKind
	SourceID   pgtype.UUID

	Type     string
	Severity string
	IssueID  pgtype.UUID
	Title    string
	Body     pgtype.Text

	ActorType pgtype.Text
	ActorID   pgtype.UUID
	Details   []byte

	TargetKind pgtype.Text
	TargetID   pgtype.UUID

	// DeliveryKey is derived by the producer from the originating entity, never
	// from a row id, so a retry recomputes it and collides instead of creating a
	// second notification.
	DeliveryKey pgtype.Text
}

// Result reports what a delivery did.
//
// Deduplicated means the delivery had already been recorded: nothing advanced,
// and the caller must not emit a websocket event — re-emitting would make a
// retry look like a second notification to every connected client.
//
// GateOpen reports whether the v2 half ran at all. With the gate closed the
// legacy row is still written and Group is zero.
type Result struct {
	Item         db.InboxItem
	Group        db.InboxGroup
	Deduplicated bool
	GateOpen     bool
}

// Writer performs the delivery write path.
type Writer struct {
	q  *db.Queries
	tx TxStarter
}

func NewWriter(q *db.Queries, tx TxStarter) *Writer {
	return &Writer{q: q, tx: tx}
}

// Deliver writes one notification.
//
// Everything happens in one transaction, and the order inside it is the
// contract:
//
//  1. Read the cutover row. Reading it HERE, rather than from a cached flag, is
//     what makes the switch atomic with respect to every delivery: with a
//     per-process flag there is a window where some instances write groups and
//     some do not, and the rows written in that window are precisely the ones
//     reconcile would have to find afterwards.
//  2. Gate closed → write the legacy row exactly as before and stop. This is
//     the pre-v2 behaviour byte for byte, which is what lets the code ship long
//     before the switch is touched.
//  3. Probe by delivery key. A hit returns the existing row without advancing
//     anything.
//  4. Acquire (create or lock) the group. This lock is the fixed point of the
//     lock order every write path in this package shares: group first, then its
//     items.
//  5. Allocate event_seq = latest_seq+1 and a created_at that is monotonic
//     within the group, insert the item, advance the group, refresh the mirror.
//
// Allocating the sequence inside the lock is what makes it gapless, and writing
// it in the same transaction as the insert is what makes a failure roll the
// number back too — by transaction atomicity rather than by convention.
func (w *Writer) Deliver(ctx context.Context, d Delivery, now time.Time) (Result, error) {
	if d.SourceKind == "" {
		return Result{}, errors.New("inboxv2: source kind required")
	}
	if !d.SourceID.Valid {
		return Result{}, errors.New("inboxv2: source id required")
	}

	res, err := w.deliverOnce(ctx, d, now)
	if err == nil {
		return res, nil
	}

	// Two transactions can both miss the delivery-key probe; the unique index
	// decides. The loser rolls back whole and re-reads the winner's row, so both
	// callers describe the same single notification.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
		return w.loadExisting(ctx, d)
	}
	return Result{}, err
}

func (w *Writer) deliverOnce(ctx context.Context, d Delivery, now time.Time) (Result, error) {
	tx, err := w.tx.Begin(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("inboxv2: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	q := w.q.WithTx(tx)

	enabled, err := q.GetInboxV2WriteEnabled(ctx)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return Result{}, fmt.Errorf("inboxv2: read cutover: %w", err)
		}
		// No cutover row at all (the migration was rolled back) reads as off,
		// which is the safe direction.
		enabled = false
	}

	if !enabled {
		item, err := q.CreateInboxItem(ctx, legacyParams(d))
		if err != nil {
			return Result{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Result{}, fmt.Errorf("inboxv2: commit: %w", err)
		}
		return Result{Item: item}, nil
	}

	if d.DeliveryKey.Valid && d.DeliveryKey.String != "" {
		existing, err := q.FindInboxItemByDeliveryKey(ctx, d.DeliveryKey)
		if err == nil {
			group, gerr := q.GetInboxGroupForRecipient(ctx, db.GetInboxGroupForRecipientParams{
				ID:          existing.GroupID,
				WorkspaceID: d.WorkspaceID,
				RecipientID: d.RecipientID,
			})
			if gerr != nil {
				return Result{}, fmt.Errorf("inboxv2: load group for duplicate: %w", gerr)
			}
			if err := tx.Commit(ctx); err != nil {
				return Result{}, fmt.Errorf("inboxv2: commit: %w", err)
			}
			return Result{Item: existing, Group: group, Deduplicated: true, GateOpen: true}, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return Result{}, fmt.Errorf("inboxv2: delivery key probe: %w", err)
		}
	}

	group, err := q.AcquireInboxGroup(ctx, db.AcquireInboxGroupParams{
		WorkspaceID: d.WorkspaceID,
		RecipientID: d.RecipientID,
		SourceKind:  string(d.SourceKind),
		SourceID:    d.SourceID,
		Now:         pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		return Result{}, fmt.Errorf("inboxv2: acquire group: %w", err)
	}

	seq := group.LatestSeq + 1
	createdAt := monotonicCreatedAt(now, group.LatestEventAt)

	item, err := q.InsertInboxItemForGroup(ctx, db.InsertInboxItemForGroupParams{
		WorkspaceID: d.WorkspaceID,
		RecipientID: d.RecipientID,
		Type:        d.Type,
		Severity:    d.Severity,
		IssueID:     d.IssueID,
		Title:       d.Title,
		Body:        d.Body,
		ActorType:   d.ActorType,
		ActorID:     d.ActorID,
		Details:     d.Details,
		GroupID:     group.ID,
		EventSeq:    pgtype.Int8{Int64: seq, Valid: true},
		TargetKind:  d.TargetKind,
		TargetID:    d.TargetID,
		DeliveryKey: d.DeliveryKey,
		CreatedAt:   pgtype.Timestamptz{Time: createdAt, Valid: true},
	})
	if err != nil {
		return Result{}, err
	}

	group, err = q.AdvanceInboxGroupForItem(ctx, db.AdvanceInboxGroupForItemParams{
		EventSeq:  seq,
		EventID:   item.ID,
		CreatedAt: pgtype.Timestamptz{Time: createdAt, Valid: true},
		Now:       pgtype.Timestamptz{Time: now, Valid: true},
		ID:        group.ID,
	})
	if err != nil {
		return Result{}, fmt.Errorf("inboxv2: advance group: %w", err)
	}

	if _, err := q.RefreshInboxItemMirror(ctx, group.ID); err != nil {
		return Result{}, fmt.Errorf("inboxv2: refresh mirror: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return Result{}, fmt.Errorf("inboxv2: commit: %w", err)
	}
	// Re-read the inserted row so the caller sees the mirror the refresh just
	// applied rather than the pre-refresh booleans RETURNING gave back.
	item.Read = false
	item.Archived = false
	return Result{Item: item, Group: group, GateOpen: true}, nil
}

// monotonicCreatedAt keeps created_at strictly increasing within a group.
//
// The legacy endpoints order by created_at, so if two deliveries land in the
// same millisecond — or a node's clock is behind the last one — the v1 view and
// the v2 sequence would disagree about which row represents the group. One
// microsecond past the previous event is enough, and matches the column's
// resolution.
func monotonicCreatedAt(now time.Time, previous pgtype.Timestamptz) time.Time {
	if previous.Valid && !now.After(previous.Time) {
		return previous.Time.Add(time.Microsecond)
	}
	return now
}

func (w *Writer) loadExisting(ctx context.Context, d Delivery) (Result, error) {
	item, err := w.q.FindInboxItemByDeliveryKey(ctx, d.DeliveryKey)
	if err != nil {
		return Result{}, fmt.Errorf("inboxv2: reload after conflict: %w", err)
	}
	group, err := w.q.GetInboxGroupForRecipient(ctx, db.GetInboxGroupForRecipientParams{
		ID:          item.GroupID,
		WorkspaceID: d.WorkspaceID,
		RecipientID: d.RecipientID,
	})
	if err != nil {
		return Result{}, fmt.Errorf("inboxv2: reload group after conflict: %w", err)
	}
	return Result{Item: item, Group: group, Deduplicated: true, GateOpen: true}, nil
}

// legacyParams is the pre-v2 write, unchanged. Keeping it here rather than at
// the call sites means a producer's code path is identical either way and the
// gate alone decides which shape the row takes.
func legacyParams(d Delivery) db.CreateInboxItemParams {
	return db.CreateInboxItemParams{
		WorkspaceID:   d.WorkspaceID,
		RecipientType: "member",
		RecipientID:   d.RecipientID,
		Type:          d.Type,
		Severity:      d.Severity,
		IssueID:       d.IssueID,
		Title:         d.Title,
		Body:          d.Body,
		ActorType:     d.ActorType,
		ActorID:       d.ActorID,
		Details:       d.Details,
	}
}

// IsUnread is the single derived unread rule. Every count, badge and mirror
// refresh goes through the same expression so the three clients cannot drift
// into separate definitions the way they did with the old boolean.
func IsUnread(g db.InboxGroup) bool {
	return g.ManualUnread || g.ReadThroughSeq < g.LatestSeq
}

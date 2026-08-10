package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestHermesMemoryProfileSegment covers the store segment derived from a
// resolved source home: named profiles and the default home stay readable (an
// operator has to be able to find the directory), an out-of-tree custom home
// falls back to a hash of its path.
func TestHermesMemoryProfileSegment(t *testing.T) {
	t.Parallel()

	if got := hermesMemoryProfileSegment(""); got != "default" {
		t.Fatalf("empty source home segment = %q, want default", got)
	}
	if got := hermesMemoryProfileSegment(platformDefaultHermesHome()); got != "default" {
		t.Fatalf("platform default segment = %q, want default", got)
	}
	// A profile of the native root keeps its bare, readable name.
	native := filepath.Join(platformDefaultHermesHome(), "profiles", "research")
	if got := hermesMemoryProfileSegment(native); got != "research" {
		t.Fatalf("native named profile segment = %q, want research", got)
	}
	// Same profile name under a different root must not share a memory line.
	root := t.TempDir()
	foreign := hermesMemoryProfileSegment(filepath.Join(root, "profiles", "research"))
	if foreign == "research" {
		t.Fatalf("foreign-root profile collided with the native one on %q", foreign)
	}
	if !strings.HasPrefix(foreign, "research_") {
		t.Fatalf("foreign-root profile segment = %q, want a research_<hash> form", foreign)
	}

	custom := hermesMemoryProfileSegment(filepath.Join(root, "custom-home"))
	if !strings.HasPrefix(custom, "h_") {
		t.Fatalf("custom home segment = %q, want an h_ hash", custom)
	}
	// Same basename in a different location must not collide.
	other := hermesMemoryProfileSegment(filepath.Join(root, "nested", "custom-home"))
	if custom == other {
		t.Fatalf("distinct custom homes collided on %q", custom)
	}
}

// TestHermesMemoryStorePathLayout pins the on-disk layout the documented
// one-off import depends on: <profile dir>/hermes-state/<agent>/<profile>.
func TestHermesMemoryStorePathLayout(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	agent := "11111111-2222-3333-4444-555555555555"
	got := HermesMemoryStorePath("", agent, filepath.Join(platformDefaultHermesHome(), "profiles", "research"))
	want := filepath.Join(home, ".multica", hermesMemoryStoreRoot, agent, "research")
	if got != want {
		t.Fatalf("store path = %q, want %q", got, want)
	}
}

// TestHermesMemoryStorePathDisabled covers the two ways memory stays
// task-local: no agent to key on, and the operator rollback switch.
func TestHermesMemoryStorePathDisabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	if got := HermesMemoryStorePath("", "", ""); got != "" {
		t.Fatalf("store path without an agent = %q, want empty", got)
	}

	t.Setenv(MulticaHermesTaskMemoryEnv, "1")
	if got := HermesMemoryStorePath("", "agent-1", ""); got != "" {
		t.Fatalf("store path with the rollback switch on = %q, want empty", got)
	}
}

// TestPrepareHermesHomeMemoryStorePersistsAcrossTasks is the regression test for
// #6638: an agent with skills bound must keep its memory between tasks. Each
// task gets a fresh overlay home, so the memory can only survive if memories/
// resolves to the shared per-agent store.
func TestPrepareHermesHomeMemoryStorePersistsAcrossTasks(t *testing.T) {
	t.Parallel()
	sharedHome := t.TempDir()
	store := filepath.Join(t.TempDir(), "hermes-state", "agent-1", "default")
	skills := []SkillContextForEnv{{Name: "deploy", Content: "# Deploy"}}

	firstTask := filepath.Join(t.TempDir(), "hermes-home")
	if err := prepareHermesHome(firstTask, sharedHome, false, skills, nil, store, testLogger()); err != nil {
		t.Fatalf("prepare first task: %v", err)
	}
	// Hermes writes memory back into <HERMES_HOME>/memories during the run.
	mustWrite(t, filepath.Join(firstTask, "memories", "MEMORY.md"), "prefers tabs")

	secondTask := filepath.Join(t.TempDir(), "hermes-home")
	if err := prepareHermesHome(secondTask, sharedHome, false, skills, nil, store, testLogger()); err != nil {
		t.Fatalf("prepare second task: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(secondTask, "memories", "MEMORY.md"))
	if err != nil {
		t.Fatalf("second task lost the agent's memory: %v", err)
	}
	if string(got) != "prefers tabs" {
		t.Fatalf("memory content = %q, want %q", got, "prefers tabs")
	}

	// The link must point at the store, not hold a copy — otherwise the next
	// task's writes would diverge from it.
	fi, err := os.Lstat(filepath.Join(secondTask, "memories"))
	if err != nil {
		t.Fatalf("lstat memories: %v", err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("memories is not a link (mode %v)", fi.Mode())
	}
}

// TestPrepareHermesHomeMemoryStoreIsolatesAgents guards the isolation promise
// the store makes: one agent's memory must never be visible to another.
func TestPrepareHermesHomeMemoryStoreIsolatesAgents(t *testing.T) {
	t.Parallel()
	sharedHome := t.TempDir()
	stateRoot := t.TempDir()
	skills := []SkillContextForEnv{{Name: "deploy", Content: "# Deploy"}}

	homeA := filepath.Join(t.TempDir(), "hermes-home")
	if err := prepareHermesHome(homeA, sharedHome, false, skills, nil, filepath.Join(stateRoot, "agent-a", "default"), testLogger()); err != nil {
		t.Fatalf("prepare agent A: %v", err)
	}
	mustWrite(t, filepath.Join(homeA, "memories", "MEMORY.md"), "agent A secret")

	homeB := filepath.Join(t.TempDir(), "hermes-home")
	if err := prepareHermesHome(homeB, sharedHome, false, skills, nil, filepath.Join(stateRoot, "agent-b", "default"), testLogger()); err != nil {
		t.Fatalf("prepare agent B: %v", err)
	}
	if _, err := os.Stat(filepath.Join(homeB, "memories", "MEMORY.md")); !os.IsNotExist(err) {
		t.Fatalf("agent B can see agent A's memory (err = %v)", err)
	}
}

// TestPrepareHermesHomeMemoryStoreRollback verifies the operator switch: with no
// store the overlay keeps a plain task-local memories dir, i.e. the old
// behaviour, and never leaves a dangling link behind.
func TestPrepareHermesHomeMemoryStoreRollback(t *testing.T) {
	t.Parallel()
	sharedHome := t.TempDir()
	hermesHome := filepath.Join(t.TempDir(), "hermes-home")
	skills := []SkillContextForEnv{{Name: "deploy", Content: "# Deploy"}}

	if err := prepareHermesHome(hermesHome, sharedHome, false, skills, nil, "", testLogger()); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	fi, err := os.Lstat(filepath.Join(hermesHome, "memories"))
	if err != nil {
		t.Fatalf("lstat memories: %v", err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("memories should be a real dir without a store, got a link")
	}
	if !fi.IsDir() {
		t.Fatalf("memories is not a directory (mode %v)", fi.Mode())
	}
}

// TestPrepareHermesHomeMigratesTaskLocalMemories covers the upgrade path: a
// workdir reused from a pre-store daemon still holds a real memories/ dir, whose
// contents must move into the (empty) store rather than be dropped.
func TestPrepareHermesHomeMigratesTaskLocalMemories(t *testing.T) {
	t.Parallel()
	sharedHome := t.TempDir()
	hermesHome := filepath.Join(t.TempDir(), "hermes-home")
	skills := []SkillContextForEnv{{Name: "deploy", Content: "# Deploy"}}

	// Simulate the old layout: a task-local memories dir with accumulated state.
	if err := prepareHermesHome(hermesHome, sharedHome, false, skills, nil, "", testLogger()); err != nil {
		t.Fatalf("prepare pre-store overlay: %v", err)
	}
	mustWrite(t, filepath.Join(hermesHome, "memories", "MEMORY.md"), "carried over")

	store := filepath.Join(t.TempDir(), "hermes-state", "agent-1", "default")
	if err := prepareHermesHome(hermesHome, sharedHome, false, skills, nil, store, testLogger()); err != nil {
		t.Fatalf("prepare with store: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(store, "MEMORY.md"))
	if err != nil {
		t.Fatalf("task-local memory was not migrated into the store: %v", err)
	}
	if string(got) != "carried over" {
		t.Fatalf("migrated content = %q, want %q", got, "carried over")
	}
}

// TestPrepareHermesHomeMigrationKeepsExistingStore is the other half of the
// upgrade path: an agent that already accumulated memory must never have it
// overwritten by a stale task-local dir.
func TestPrepareHermesHomeMigrationKeepsExistingStore(t *testing.T) {
	t.Parallel()
	sharedHome := t.TempDir()
	hermesHome := filepath.Join(t.TempDir(), "hermes-home")
	skills := []SkillContextForEnv{{Name: "deploy", Content: "# Deploy"}}

	if err := prepareHermesHome(hermesHome, sharedHome, false, skills, nil, "", testLogger()); err != nil {
		t.Fatalf("prepare pre-store overlay: %v", err)
	}
	mustWrite(t, filepath.Join(hermesHome, "memories", "MEMORY.md"), "stale task copy")

	store := filepath.Join(t.TempDir(), "hermes-state", "agent-1", "default")
	mustWrite(t, filepath.Join(store, "MEMORY.md"), "authoritative agent memory")

	if err := prepareHermesHome(hermesHome, sharedHome, false, skills, nil, store, testLogger()); err != nil {
		t.Fatalf("prepare with store: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(store, "MEMORY.md"))
	if err != nil {
		t.Fatalf("read store memory: %v", err)
	}
	if string(got) != "authoritative agent memory" {
		t.Fatalf("store memory was overwritten by the task-local copy: %q", got)
	}
}

// TestPruneHermesMemoryStores covers the GC contract: stores idle past retention
// are reclaimed, recently-used ones are kept, and a store a live task holds is
// never removed.
func TestPruneHermesMemoryStores(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	root := filepath.Join(home, ".multica", hermesMemoryStoreRoot)
	idle := filepath.Join(root, "agent-idle", "default")
	fresh := filepath.Join(root, "agent-fresh", "default")
	held := filepath.Join(root, "agent-held", "default")
	for _, dir := range []string{idle, fresh, held} {
		mustWrite(t, filepath.Join(dir, "MEMORY.md"), "remembered")
	}

	now := time.Now()
	old := now.Add(-30 * 24 * time.Hour)
	for _, dir := range []string{idle, held} {
		if err := os.Chtimes(filepath.Join(dir, "MEMORY.md"), old, old); err != nil {
			t.Fatalf("age store: %v", err)
		}
		if err := os.Chtimes(dir, old, old); err != nil {
			t.Fatalf("age store dir: %v", err)
		}
	}

	reserve := func(storeDir string) (func(), bool) {
		if storeDir == held {
			return nil, false // a live task holds it
		}
		return func() {}, true
	}

	removed, freed := PruneHermesMemoryStores("", 14*24*time.Hour, now, reserve, testLogger())
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if freed <= 0 {
		t.Fatalf("bytesFreed = %d, want > 0", freed)
	}
	if _, err := os.Stat(idle); !os.IsNotExist(err) {
		t.Fatalf("idle store survived the prune (err = %v)", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("recently used store was reclaimed: %v", err)
	}
	if _, err := os.Stat(held); err != nil {
		t.Fatalf("store held by a live task was reclaimed: %v", err)
	}
}

// TestPruneHermesMemoryStoresDisabled documents that retention <= 0 turns the
// pruner off entirely, matching the Codex store knob.
func TestPruneHermesMemoryStoresDisabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	store := filepath.Join(home, ".multica", hermesMemoryStoreRoot, "agent-1", "default")
	mustWrite(t, filepath.Join(store, "MEMORY.md"), "remembered")
	old := time.Now().Add(-365 * 24 * time.Hour)
	if err := os.Chtimes(store, old, old); err != nil {
		t.Fatalf("age store: %v", err)
	}

	if removed, _ := PruneHermesMemoryStores("", 0, time.Now(), nil, testLogger()); removed != 0 {
		t.Fatalf("removed = %d with pruning disabled, want 0", removed)
	}
	if _, err := os.Stat(store); err != nil {
		t.Fatalf("store was reclaimed with pruning disabled: %v", err)
	}
}

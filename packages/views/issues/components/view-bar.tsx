"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { ChevronDown, Layers, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@multica/ui/components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import type { IssueView } from "@multica/core/api/schemas";
import {
  canManageIssueView,
  type IssueViewScope,
} from "@multica/core/issue-views/queries";
import {
  applyViewBarPrefs,
  issueViewPreferenceOptions,
  useUpdateIssueViewPreference,
  EMPTY_VIEW_BAR_PREFS,
} from "@multica/core/issue-views/preferences";
import { useDeleteIssueView } from "@multica/core/issue-views/mutations";
import { useAuthStore } from "@multica/core/auth";
import { memberListOptions } from "@multica/core/workspace/queries";
import { pinListOptions } from "@multica/core/pins/queries";
import { useCreatePin, useDeletePin } from "@multica/core/pins/mutations";
import { useSingleRowFit } from "../../common/single-row-fit";
import {
  DeleteViewConfirm,
  ViewListPanel,
  type ViewBarItem,
} from "./view-bar-popover";
import { useT } from "../../i18n";

export interface ViewBarBuiltin {
  key: string;
  label: string;
  description?: string;
  active: boolean;
  onSelect: () => void;
}

/** Width shared by every tab: fits short names, truncates long ones. */
const TAB_MAX_W = "max-w-40";
/** Reserved px for the trailing trigger in its two shapes. */
const RESERVE_ICON = 36;
const RESERVE_PROMOTED = 208;

/** One bar tab: sortable in place; suppresses the click that ends a drag. */
function SortableBarTab({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const wasDragged = useRef(false);
  useEffect(() => {
    if (isDragging) {
      wasDragged.current = true;
      return;
    }
    if (!wasDragged.current) return;
    // A drop lands as a click (swallowed below); a cancelled drag (Escape)
    // produces none — clear the flag a tick later so the NEXT real click
    // isn't eaten by a drag that never dropped.
    const timer = window.setTimeout(() => {
      wasDragged.current = false;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isDragging]);
  return (
    // Listeners only — dnd-kit's aria attributes would make this span a
    // second focusable role=button wrapping the real tab button.
    <span
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("inline-flex", isDragging && "z-10 opacity-70")}
      {...listeners}
      onClickCapture={(event) => {
        if (wasDragged.current) {
          wasDragged.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
    </span>
  );
}

/** Shared tab chrome so the real row and the measurement mirror agree. */
function BarTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        TAB_MAX_W,
        active
          ? "bg-accent text-accent-foreground hover:bg-accent/80"
          : "text-muted-foreground",
      )}
      onClick={onClick}
      tabIndex={onClick ? undefined : -1}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
}

/**
 * The view bar: built-in tabs and saved views as one flat, per-user
 * orderable single row. Tabs that don't fit collapse into the trailing
 * popover (which lists everything — reorder, per-row actions, new view).
 * When the OPEN view itself is overflowed it takes the trigger's place,
 * so the active view is always visible. Both reorder surfaces (inline
 * drag, popover drag) write one preference document.
 */
export function ViewBar({
  wsId,
  scope,
  builtins,
  views,
  viewsReady,
  activeView,
  onSelectView,
  onNewView,
  onEditView,
}: {
  wsId: string;
  scope: IssueViewScope;
  builtins: ViewBarBuiltin[];
  views: IssueView[];
  /** True once the views list has actually loaded — see savePrefs. */
  viewsReady: boolean;
  activeView: IssueView | null;
  onSelectView: (view: IssueView | null) => void;
  onNewView: () => void;
  /** Opens the edit dialog seeded from the view's own definition. */
  onEditView: (view: IssueView) => void;
}) {
  const { t } = useT("issues");
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { data: preference } = useQuery(issueViewPreferenceOptions(wsId, scope));
  const prefs = preference?.prefs ?? EMPTY_VIEW_BAR_PREFS;
  const updatePreference = useUpdateIssueViewPreference(wsId, scope);
  const deleteView = useDeleteIssueView(wsId);
  const [listOpen, setListOpen] = useState(false);
  const [deleting, setDeleting] = useState<IssueView | null>(null);

  // The same manage rule the server enforces: owner, or workspace
  // owner/admin for shared views. Members load from cache in one query.
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const myRole = useMemo(
    () => members.find((m) => m.user_id === currentUserId)?.role ?? null,
    [members, currentUserId],
  );

  const { data: pins = [] } = useQuery({
    ...pinListOptions(wsId, currentUserId ?? ""),
    enabled: !!currentUserId,
  });
  const pinnedViewIds = useMemo(
    () =>
      new Set(
        pins.filter((p) => p.item_type === "view").map((p) => p.item_id),
      ),
    [pins],
  );
  const createPin = useCreatePin();
  const deletePin = useDeletePin();

  const anchorId = builtins.length > 0 ? `builtin:${builtins[0]!.key}` : "";

  const items = useMemo<ViewBarItem[]>(
    () => [
      ...builtins.map((b) => ({
        barItemId: `builtin:${b.key}`,
        label: b.label,
        kind: "builtin" as const,
      })),
      ...views.map((view) => ({
        barItemId: `view:${view.id}`,
        label: view.name,
        kind: "view" as const,
        view,
        canManage: canManageIssueView(view, currentUserId, myRole),
      })),
    ],
    [builtins, views, currentUserId, myRole],
  );

  const { visible, hiddenSet, ordered } = useMemo(
    () => applyViewBarPrefs(items, prefs, anchorId),
    [items, prefs, anchorId],
  );

  const builtinByKey = useMemo(
    () => new Map(builtins.map((b) => [`builtin:${b.key}`, b])),
    [builtins],
  );

  // --- single-row fit -----------------------------------------------------
  const activeBarId = activeView ? `view:${activeView.id}` : null;
  // Promotion feeds back into the reserve: with the wider promoted trigger
  // the fit can only shrink, which keeps the active tab overflowed — the
  // two-pass settle is stable.
  const [promoted, setPromoted] = useState(false);
  const { containerRef, measureRef, fitCount } = useSingleRowFit({
    count: visible.length,
    gap: 4,
    reserve: promoted ? RESERVE_PROMOTED : RESERVE_ICON,
  });
  const fitting = visible.slice(0, fitCount);
  const overflowed = visible.slice(fitCount);
  const activeOverflowed =
    !!activeBarId && overflowed.some((item) => item.barItemId === activeBarId);
  useEffect(() => {
    setPromoted(activeOverflowed);
  }, [activeOverflowed]);

  const savePrefs = (next: { hidden: string[]; order: string[] }) => {
    // A drag can land before the views list has loaded; pruning against an
    // in-flight (empty) list would persist "every saved view was deleted"
    // and wipe the user's order and hidden sets. Drop the write instead —
    // the gesture is re-doable one moment later.
    if (!viewsReady) return;
    // Prune ids that no longer resolve so deleted views don't accumulate.
    const known = new Set(items.map((item) => item.barItemId));
    updatePreference.mutate({
      hidden: next.hidden.filter((id) => known.has(id)),
      order: next.order.filter((id) => known.has(id)),
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // Reorder within the FULL ordered document so the bar and the popover
    // edit one list; the dragged item lands adjacent to the drop target.
    const ids = ordered.map((item) => item.barItemId);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    savePrefs({ hidden: [...hiddenSet], order: arrayMove(ids, from, to) });
  };

  const confirmDelete = async (view: IssueView) => {
    await deleteView.mutateAsync(view.id);
    if (activeView?.id === view.id) onSelectView(null);
  };

  const toggleHidden = (barItemId: string, hidden: boolean) => {
    const nextHidden = new Set(hiddenSet);
    if (hidden) nextHidden.add(barItemId);
    else nextHidden.delete(barItemId);
    savePrefs({
      hidden: [...nextHidden],
      order: ordered.map((item) => item.barItemId),
    });
    // Hiding the open view exits it — an invisible active view would
    // strand the surface with no matching tab.
    if (hidden && activeView && barItemId === `view:${activeView.id}`) {
      onSelectView(null);
    }
  };

  const selectItem = (item: ViewBarItem) => {
    if (hiddenSet.has(item.barItemId)) {
      // Selecting a hidden row implies wanting it back on the bar.
      toggleHidden(item.barItemId, false);
    }
    if (item.kind === "builtin") {
      builtinByKey.get(item.barItemId)?.onSelect();
    } else if (item.view) {
      onSelectView(item.view);
    }
    setListOpen(false);
  };

  const renderViewTab = (item: ViewBarItem) => {
    const view = item.view!;
    const active = activeView?.id === view.id;
    const pinned = pinnedViewIds.has(view.id);
    return (
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn(
                TAB_MAX_W,
                active
                  ? "bg-accent text-accent-foreground hover:bg-accent/80"
                  : "text-muted-foreground",
              )}
              onClick={() => onSelectView(active ? null : view)}
            />
          }
        >
          <span className="truncate">{view.name}</span>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {/* Edit stays visible but disabled without permission — the greyed
              row IS the "you can't" signal. Delete is hidden entirely: a
              destructive dead-end invites a doomed confirm flow. */}
          <ContextMenuItem
            disabled={!item.canManage}
            onClick={() => onEditView(view)}
          >
            <Pencil className="size-3.5" />
            {t(($) => $.view_bar.context_edit)}
          </ContextMenuItem>
          {item.canManage && (
            <ContextMenuItem
              variant="destructive"
              onClick={() => setDeleting(view)}
            >
              <Trash2 className="size-3.5" />
              {t(($) => $.view_bar.delete)}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() =>
              pinned
                ? deletePin.mutate({ itemType: "view", itemId: view.id })
                : createPin.mutate({ item_type: "view", item_id: view.id })
            }
          >
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            {pinned
              ? t(($) => $.view_bar.context_unpin)
              : t(($) => $.view_bar.context_pin)}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div
      ref={containerRef}
      className="relative flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden"
    >
      {/* Measurement mirror: every visible candidate at natural width. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1"
      >
        {visible.map((item) => (
          <span key={item.barItemId} className="inline-flex">
            <BarTabButton label={item.label} />
          </span>
        ))}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        // Same gesture contract as the table's column reordering: tabs slide
        // along the row only. Overflowed items reorder inside the popover.
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={fitting.map((item) => item.barItemId)}
          strategy={horizontalListSortingStrategy}
        >
          {fitting.map((item) => {
            if (item.kind === "builtin") {
              const b = builtinByKey.get(item.barItemId);
              if (!b) return null;
              const button = (
                <BarTabButton label={b.label} active={b.active} onClick={b.onSelect} />
              );
              return (
                <SortableBarTab key={item.barItemId} id={item.barItemId}>
                  {b.description ? (
                    <Tooltip>
                      <TooltipTrigger render={button} />
                      <TooltipContent side="bottom">{b.description}</TooltipContent>
                    </Tooltip>
                  ) : (
                    button
                  )}
                </SortableBarTab>
              );
            }
            return (
              <SortableBarTab key={item.barItemId} id={item.barItemId}>
                {renderViewTab(item)}
              </SortableBarTab>
            );
          })}
        </SortableContext>
      </DndContext>

      <Popover open={listOpen} onOpenChange={setListOpen}>
        <PopoverTrigger
          render={
            promoted && activeView ? (
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  TAB_MAX_W,
                  "shrink-0 gap-1 bg-accent text-accent-foreground hover:bg-accent/80",
                )}
              >
                <span className="truncate">{activeView.name}</span>
                <ChevronDown className="size-3 shrink-0" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(($) => $.view_bar.menu_label)}
                className="shrink-0 text-muted-foreground"
              >
                <Layers className="size-3.5" />
              </Button>
            )
          }
        />
        <PopoverContent align="end" className="w-72 p-0">
          <ViewListPanel
            items={ordered}
            hiddenSet={hiddenSet}
            anchorId={anchorId}
            activeViewId={activeView?.id ?? null}
            pinnedViewIds={pinnedViewIds}
            onReorder={(orderedIds) =>
              savePrefs({ hidden: [...hiddenSet], order: orderedIds })
            }
            onToggleHidden={toggleHidden}
            onSelectItem={selectItem}
            onEditView={(view) => {
              setListOpen(false);
              onEditView(view);
            }}
            onDeleteView={confirmDelete}
            onTogglePin={(view, pinned) =>
              pinned
                ? deletePin.mutate({ itemType: "view", itemId: view.id })
                : createPin.mutate({ item_type: "view", item_id: view.id })
            }
            onNewView={() => {
              setListOpen(false);
              onNewView();
            }}
          />
        </PopoverContent>
      </Popover>

      {/* Context-menu delete shares the popover's confirm. */}
      <DeleteViewConfirm
        view={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

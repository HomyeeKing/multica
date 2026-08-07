"use client";

import { useMemo, useRef, useState } from "react";
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
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Layers, Pencil, Pin, PinOff, Plus, Settings2, Trash2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@multica/ui/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
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
import {
  DeleteViewConfirm,
  ManageViewsDialog,
  type ViewBarItem,
} from "./manage-views-dialog";
import { useT } from "../../i18n";

export interface ViewBarBuiltin {
  key: string;
  label: string;
  description?: string;
  active: boolean;
  onSelect: () => void;
}

/** One bar tab: sortable in place; suppresses the click that ends a drag. */
function SortableBarTab({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const wasDragged = useRef(false);
  if (isDragging) wasDragged.current = true;
  return (
    <span
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("inline-flex", isDragging && "z-10 opacity-70")}
      {...attributes}
      {...listeners}
      onClickCapture={(event) => {
        // A drop lands as a click on the tab — swallow it so finishing a
        // drag never toggles the tab you happened to release over.
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

/**
 * The view bar: built-in tabs and saved views as one flat, per-user
 * orderable row (wraps instead of overflowing). Tabs reorder by drag —
 * writing the same preference document the manage dialog edits — and
 * saved-view tabs carry a context menu (edit / delete under the same
 * permission rule as the server, pin to sidebar for everyone).
 */
export function ViewBar({
  wsId,
  scope,
  builtins,
  views,
  activeView,
  onSelectView,
  onNewView,
  onEditView,
}: {
  wsId: string;
  scope: IssueViewScope;
  builtins: ViewBarBuiltin[];
  views: IssueView[];
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
  const [manageOpen, setManageOpen] = useState(false);
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

  const savePrefs = (next: { hidden: string[]; order: string[] }) => {
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
    // Reorder within the FULL ordered document (hidden items keep their
    // slots) so the bar and the manage dialog stay one list.
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

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visible.map((item) => item.barItemId)}
          strategy={rectSortingStrategy}
        >
          {visible.map((item) => {
            if (item.kind === "builtin") {
              const b = builtinByKey.get(item.barItemId);
              if (!b) return null;
              const button = (
                <Button
                  variant="outline"
                  size="sm"
                  className={
                    b.active
                      ? "bg-accent text-accent-foreground hover:bg-accent/80"
                      : "text-muted-foreground"
                  }
                  onClick={b.onSelect}
                >
                  {b.label}
                </Button>
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
            const view = item.view!;
            const active = activeView?.id === view.id;
            const pinned = pinnedViewIds.has(view.id);
            return (
              <SortableBarTab key={item.barItemId} id={item.barItemId}>
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          "max-w-48",
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
                    {/* Edit stays visible but disabled without permission —
                        the greyed row IS the "you can't" signal. Delete is
                        hidden entirely: a destructive dead-end invites a
                        doomed confirm flow. */}
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
                      {pinned ? (
                        <PinOff className="size-3.5" />
                      ) : (
                        <Pin className="size-3.5" />
                      )}
                      {pinned
                        ? t(($) => $.view_bar.context_unpin)
                        : t(($) => $.view_bar.context_pin)}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </SortableBarTab>
            );
          })}
        </SortableContext>
      </DndContext>

      <DropdownMenu>
        <Tooltip>
          <DropdownMenuTrigger
            render={
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(($) => $.view_bar.menu_label)}
                    className="text-muted-foreground"
                  >
                    <Layers className="size-3.5" />
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="bottom">{t(($) => $.view_bar.menu_label)}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onClick={onNewView}>
            <Plus className="size-3.5" />
            {t(($) => $.view_bar.menu_new)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setManageOpen(true)}>
            <Settings2 className="size-3.5" />
            {t(($) => $.view_bar.menu_manage)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ManageViewsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        items={ordered}
        hiddenSet={hiddenSet}
        anchorId={anchorId}
        onReorder={(orderedIds) => savePrefs({ hidden: [...hiddenSet], order: orderedIds })}
        onToggleHidden={(barItemId, hidden) => {
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
        }}
        onEditView={(view) => {
          setManageOpen(false);
          onEditView(view);
        }}
        onDeleteView={confirmDelete}
      />

      {/* Context-menu delete shares the manage dialog's confirm. */}
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

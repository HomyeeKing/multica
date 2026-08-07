"use client";

import { useState } from "react";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  Eye,
  EyeOff,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { cn } from "@multica/ui/lib/utils";
import type { IssueView } from "@multica/core/api/schemas";
import { useT } from "../../i18n";

/** One entry on the bar: a built-in tab or a saved view. */
export interface ViewBarItem {
  barItemId: string;
  label: string;
  kind: "builtin" | "view";
  view?: IssueView;
  canManage?: boolean;
}

/** The vertical-locked row drag has no DragOverlay under the pointer, so
 *  the grabbing cursor is promoted to the document for the drag's duration
 *  (see the `data-dnd-dragging` contract in ui/styles/base.css). */
function setDndCursor(on: boolean) {
  if (on) document.documentElement.dataset.dndDragging = "true";
  else delete document.documentElement.dataset.dndDragging;
}

/**
 * The one delete-view confirmation, shared by the popover rows and the
 * bar's context menu so every entrance carries identical copy and the
 * same "deletes the view only, never issues" contract.
 */
export function DeleteViewConfirm({
  view,
  onOpenChange,
  onConfirm,
}: {
  view: IssueView | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (view: IssueView) => Promise<void>;
}) {
  const { t } = useT("issues");
  return (
    <AlertDialog open={!!view} onOpenChange={(v) => !v && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.view_bar.delete_title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.view_bar.delete_description, { name: view?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t(($) => $.save_view.cancel)}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const target = view;
              onOpenChange(false);
              if (!target) return;
              void onConfirm(target).then(
                () => toast.success(t(($) => $.view_bar.toast_deleted)),
                () => toast.error(t(($) => $.save_view.toast_failed)),
              );
            }}
          >
            {t(($) => $.view_bar.delete)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SortableViewRow({
  item,
  hidden,
  anchor,
  active,
  pinned,
  onSelect,
  onToggleHidden,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  item: ViewBarItem;
  hidden: boolean;
  /** The anchor built-in cannot be hidden and carries no menu. */
  anchor: boolean;
  active: boolean;
  pinned: boolean;
  onSelect: () => void;
  onToggleHidden: () => void;
  onTogglePin?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useT("issues");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.barItemId });
  const isView = item.kind === "view";

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/view-row flex items-center gap-1.5 rounded-md px-1.5 py-1",
        isDragging && "z-10 bg-accent opacity-80",
        !isDragging && "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t(($) => $.view_bar.drag_handle)}
        className={cn(
          "cursor-grab active:cursor-grabbing text-faint-foreground hover:text-muted-foreground",
          isDragging && "cursor-grabbing",
        )}
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 text-left text-body",
          hidden && "text-muted-foreground",
          active && "font-medium",
        )}
      >
        <span className="truncate">{item.label}</span>
        {item.kind === "builtin" && (
          <span className="shrink-0 text-caption text-muted-foreground">
            {t(($) => $.view_bar.builtin_tag)}
          </span>
        )}
        {hidden && (
          <EyeOff className="size-3 shrink-0 text-faint-foreground" />
        )}
      </button>
      {!anchor && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(($) => $.view_bar.row_menu)}
                className="text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/view-row:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            {isView && (
              <>
                {/* Edit greys out without permission (the grey IS the
                    signal); delete hides — a doomed confirm helps nobody. */}
                <DropdownMenuItem disabled={!item.canManage} onClick={onEdit}>
                  <Pencil className="size-3.5" />
                  {t(($) => $.view_bar.context_edit)}
                </DropdownMenuItem>
                {item.canManage && (
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 className="size-3.5" />
                    {t(($) => $.view_bar.delete)}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onTogglePin}>
                  {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  {pinned
                    ? t(($) => $.view_bar.context_unpin)
                    : t(($) => $.view_bar.context_pin)}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={onToggleHidden}>
              {hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              {hidden
                ? t(($) => $.view_bar.row_show)
                : t(($) => $.view_bar.row_hide)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * The pulled-down view list: every bar entry (built-ins and saved views,
 * hidden ones dimmed) in preference order. Rows drag to reorder — the same
 * document the bar's inline drag writes — and carry the per-row actions.
 * Rendered inside the bar's overflow popover.
 */
export function ViewListPanel({
  items,
  hiddenSet,
  anchorId,
  activeViewId,
  pinnedViewIds,
  onReorder,
  onToggleHidden,
  onSelectItem,
  onEditView,
  onDeleteView,
  onTogglePin,
  onNewView,
}: {
  items: ViewBarItem[];
  hiddenSet: ReadonlySet<string>;
  anchorId: string;
  activeViewId: string | null;
  pinnedViewIds: ReadonlySet<string>;
  onReorder: (orderedIds: string[]) => void;
  onToggleHidden: (barItemId: string, hidden: boolean) => void;
  /** Select a row (unhiding it first when needed) — closes the popover. */
  onSelectItem: (item: ViewBarItem) => void;
  onEditView: (view: IssueView) => void;
  onDeleteView: (view: IssueView) => Promise<void>;
  onTogglePin: (view: IssueView, pinned: boolean) => void;
  onNewView: () => void;
}) {
  const { t } = useT("issues");
  const [deleting, setDeleting] = useState<IssueView | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    setDndCursor(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((item) => item.barItemId);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  };

  return (
    <div className="flex max-h-96 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          autoScroll={{ threshold: { x: 0, y: 0.15 } }}
          onDragStart={() => setDndCursor(true)}
          onDragCancel={() => setDndCursor(false)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map((item) => item.barItemId)}
            strategy={verticalListSortingStrategy}
          >
            {items.map((item) => (
              <SortableViewRow
                key={item.barItemId}
                item={item}
                hidden={hiddenSet.has(item.barItemId)}
                anchor={item.barItemId === anchorId}
                active={
                  item.kind === "view" && item.view
                    ? item.view.id === activeViewId
                    : false
                }
                pinned={!!item.view && pinnedViewIds.has(item.view.id)}
                onSelect={() => onSelectItem(item)}
                onToggleHidden={() =>
                  onToggleHidden(item.barItemId, !hiddenSet.has(item.barItemId))
                }
                onTogglePin={
                  item.view
                    ? () => onTogglePin(item.view!, pinnedViewIds.has(item.view!.id))
                    : undefined
                }
                onEdit={item.view ? () => onEditView(item.view!) : undefined}
                onDelete={item.view ? () => setDeleting(item.view!) : undefined}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <div className="border-t border-border p-1">
        <button
          type="button"
          onClick={onNewView}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-body text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t(($) => $.view_bar.menu_new)}
        </button>
      </div>

      <DeleteViewConfirm
        view={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={onDeleteView}
      />
    </div>
  );
}

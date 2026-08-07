"use client";

import {
  EyeOff,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
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

/**
 * The one delete-view confirmation, shared by the manage dialog, the bar's
 * context menu, and the overflow rows so every entrance carries identical
 * copy and the same "deletes the view only, never issues" contract.
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

/**
 * The "more" panel: just the tabs that didn't fit on the single-row bar,
 * in bar order. Rows select on click; saved-view rows carry the same
 * actions as a bar tab's context menu (they have no rendered tab to
 * right-click). Ordering/visibility management stays in the manage
 * dialog — this panel is reach, not administration.
 */
export function OverflowListPanel({
  items,
  activeViewId,
  pinnedViewIds,
  onSelectItem,
  onEditView,
  onDeleteView,
  onTogglePin,
  onToggleHidden,
}: {
  items: ViewBarItem[];
  activeViewId: string | null;
  pinnedViewIds: ReadonlySet<string>;
  onSelectItem: (item: ViewBarItem) => void;
  onEditView: (view: IssueView) => void;
  onDeleteView: (view: IssueView) => void;
  onTogglePin: (view: IssueView, pinned: boolean) => void;
  onToggleHidden: (barItemId: string) => void;
}) {
  const { t } = useT("issues");
  return (
    <div className="max-h-96 overflow-y-auto p-1">
      {items.map((item) => {
        const isView = item.kind === "view";
        const active =
          isView && item.view ? item.view.id === activeViewId : false;
        const pinned = !!item.view && pinnedViewIds.has(item.view.id);
        return (
          <div
            key={item.barItemId}
            className="group/view-row flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted/60"
          >
            <button
              type="button"
              onClick={() => onSelectItem(item)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1.5 text-left text-body",
                active ? "font-medium" : "text-foreground",
              )}
            >
              <span className="truncate">{item.label}</span>
              {item.kind === "builtin" && (
                <span className="shrink-0 text-caption text-muted-foreground">
                  {t(($) => $.view_bar.builtin_tag)}
                </span>
              )}
            </button>
            {isView && item.view && (
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
                  {/* Same permission presentation as the tab context menu:
                      edit greys out, delete hides. */}
                  <DropdownMenuItem
                    disabled={!item.canManage}
                    onClick={() => onEditView(item.view!)}
                  >
                    <Pencil className="size-3.5" />
                    {t(($) => $.view_bar.context_edit)}
                  </DropdownMenuItem>
                  {item.canManage && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDeleteView(item.view!)}
                    >
                      <Trash2 className="size-3.5" />
                      {t(($) => $.view_bar.delete)}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => onTogglePin(item.view!, pinned)}
                  >
                    {pinned ? (
                      <PinOff className="size-3.5" />
                    ) : (
                      <Pin className="size-3.5" />
                    )}
                    {pinned
                      ? t(($) => $.view_bar.context_unpin)
                      : t(($) => $.view_bar.context_pin)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onToggleHidden(item.barItemId)}>
                    <EyeOff className="size-3.5" />
                    {t(($) => $.view_bar.row_hide)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      })}
    </div>
  );
}

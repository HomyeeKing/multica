import type { BrowserWindow } from "electron";
import {
  NAVIGATION_GESTURE_CHANNEL,
  navigationGestureFromSwipe,
} from "../shared/navigation-gestures";

export function installNavigationGestures(
  win: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    win.on("swipe", (_event, direction) => {
      const gesture = navigationGestureFromSwipe(direction);
      if (!gesture) return;
      win.webContents.send(NAVIGATION_GESTURE_CHANNEL, gesture);
    });
  }

  // Windows delivers mouse back/forward side buttons as app commands (macOS
  // and Linux surface them as mouse buttons 3/4 in the renderer instead).
  win.on("app-command", (_event, command) => {
    const gesture =
      command === "browser-backward"
        ? "back"
        : command === "browser-forward"
          ? "forward"
          : null;
    if (!gesture) return;
    win.webContents.send(NAVIGATION_GESTURE_CHANNEL, gesture);
  });
}

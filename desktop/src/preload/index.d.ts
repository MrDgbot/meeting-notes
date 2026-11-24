import type { DesktopAPI } from "@shared/types";

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
  }
}

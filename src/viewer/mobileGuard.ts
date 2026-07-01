import { Platform } from "obsidian";

/**
 * Mobile memory guard (design doc §2.4).
 *
 * Obsidian mobile runs in a Capacitor webview with far less memory than the
 * desktop Electron runtime, and the occt-import-js WASM parser can exhaust it
 * on large models. We can't predict the exact tessellation cost, so we gate on
 * the raw STEP file size: above the threshold, the viewer warns and lets the
 * user opt in rather than risk a hard failure. Desktop is never gated.
 */
export const MOBILE_LARGE_FILE_BYTES = 12 * 1024 * 1024; // 12 MB

/** True when a file of this size should prompt a warning before parsing here. */
export function shouldWarnLargeModel(sizeBytes: number): boolean {
  return Platform.isMobile && sizeBytes > MOBILE_LARGE_FILE_BYTES;
}

/** Human-readable megabyte size for warning messages. */
export function formatFileSize(sizeBytes: number): string {
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

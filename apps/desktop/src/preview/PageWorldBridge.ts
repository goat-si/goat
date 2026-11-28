import { contextBridge, ipcRenderer } from "electron";
import type { PickedElementStackFrame } from "@goat/contracts";

import {
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
} from "./GuestProtocol.ts";
import { installPageWorld, type PageWorldHost } from "./PageWorld.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
const host: PageWorldHost = process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)
  ? {
      // Only the two passkey channels are reachable from the page's world.
      invokePasskey: (channel, publicKey) =>
        channel === PASSKEY_CREATE_CHANNEL || channel === PASSKEY_GET_CHANNEL
          ? ipcRenderer.invoke(channel, publicKey)
          : Promise.reject(new Error("Unsupported passkey channel.")),
    }
  : {};

/** Installed before any page script runs; calls cross into the page's world and back. */
export const pageWorld: ReturnType<typeof installPageWorld> = contextBridge.executeInMainWorld({
  func: installPageWorld,
  args: [host],
});

// Everything the page's world returns is page-controlled, so each field is checked, not trusted.
const pageField = (source: unknown, key: string): unknown =>
  typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
const pageString = (source: unknown, key: string): string | null => {
  const value = pageField(source, key);
  return typeof value === "string" ? value : null;
};
const pageNumber = (source: unknown, key: string): number | null => {
  const value = pageField(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toStackFrame = (frame: unknown): PickedElementStackFrame => ({
  functionName: pageString(frame, "functionName"),
  fileName: pageString(frame, "fileName"),
  lineNumber: pageNumber(frame, "lineNumber"),
  columnNumber: pageNumber(frame, "columnNumber"),
});

export function parsePageElementContext(context: unknown) {
  if (typeof context !== "object" || context === null) return null;
  const frames = pageField(context, "stack");
  const stack = Array.isArray(frames) ? frames.map(toStackFrame) : [];
  return {
    selector: pageString(context, "selector"),
    htmlPreview: pageString(context, "htmlPreview") ?? "",
    componentName: pageString(context, "componentName"),
    source: stack[0] ?? null,
    stack,
    styles: pageString(context, "styles") ?? "",
  };
}

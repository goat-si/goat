// @effect-diagnostics nodeBuiltinImport:off - Playwright callbacks run outside the Effect runtime.

import type { PreviewAutomationUploadInput } from "@goat/contracts";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, ElementHandle, Page } from "playwright-core";

import {
  DEFAULT_TIMEOUT_MS,
  type DispatchGate,
  elementOf,
  ServerBrowserOperationError,
  targetLocator,
} from "./ServerBrowserPage.ts";

/**
 * Puts files into a file input (or the one its label names) with a single CDP call after the gate.
 * Playwright's setter prepares the files and the frame after any check made before it, so a cut
 * could still let it land. Inputs in a child frame are refused until #1302 gives them this path.
 */
export const uploadInto = async (
  cdp: CDPSession,
  handle: ElementHandle,
  paths: ReadonlyArray<string>,
  gate: DispatchGate,
) => {
  const key = `__goatUploadTarget_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  try {
    const multiple = await handle.evaluate((element, name) => {
      type FileInput = { tagName?: string; type?: string; multiple?: boolean; disabled?: boolean };
      const target = (
        element.tagName === "LABEL" ? (element as unknown as { control: unknown }).control : element
      ) as FileInput | null;
      if (target?.tagName !== "INPUT" || target.type !== "file" || target.disabled) return null;
      (globalThis as unknown as Record<string, unknown>)[name] = target;
      return target.multiple === true;
    }, key);
    if (multiple === null)
      throw new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "This element is not an enabled file input.",
      );
    if (paths.length > 1 && !multiple)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This file input accepts one file.",
      );
    // Read from the main frame: a framed input's global is not there, so it is refused below.
    const found = await cdp.send("Runtime.evaluate", { expression: `globalThis.${key}` });
    const objectId = found.result.subtype === "node" ? found.result.objectId : undefined;
    if (objectId === undefined)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "Uploading into a file input inside a frame is not available yet. Open the frame's page in its own tab and upload there.",
      );
    const { node } = await cdp.send("DOM.describeNode", { objectId });
    gate();
    await cdp.send("DOM.setFileInputFiles", {
      files: [...paths],
      backendNodeId: node.backendNodeId,
    });
  } finally {
    void cdp.send("Runtime.evaluate", { expression: `delete globalThis.${key}` }).catch(constVoid);
  }
};

export const setInputFiles = async (
  page: Page,
  cdp: CDPSession,
  input: PreviewAutomationUploadInput,
  gate: DispatchGate,
) => {
  const locator = targetLocator(page, input);
  if (locator === null) return false;
  const handle = await elementOf(locator, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    await uploadInto(cdp, handle, input.paths, gate);
  } finally {
    void handle.dispose().catch(constVoid);
  }
  return true;
};

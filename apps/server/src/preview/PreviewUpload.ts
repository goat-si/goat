// @effect-diagnostics nodeBuiltinImport:off - Playwright callbacks run outside the Effect runtime.

import type { PreviewAutomationUploadInput } from "@goat/contracts";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, ElementHandle, Page, Protocol } from "playwright-core";

import {
  DEFAULT_TIMEOUT_MS,
  type DispatchGate,
  elementOf,
  ServerBrowserOperationError,
  targetLocator,
} from "./ServerBrowserPage.ts";

/**
 * The input stashed under `key` in a child frame's page world, on the session that owns that
 * frame: its own for an out-of-process frame, else a fresh one for the page. The page's frames are
 * listed by turning Runtime on in that session alone, so no session the tab keeps changes state.
 */
const framedInput = async (handle: ElementHandle, key: string) => {
  const frame = await handle.ownerFrame();
  if (frame === null) return undefined;
  const context = frame.page().context();
  const session = await context
    .newCDPSession(frame)
    .catch(() => context.newCDPSession(frame.page()));
  try {
    const worlds: Array<number> = [];
    const onContext = (event: Protocol.Runtime.executionContextCreatedPayload) => {
      const aux = event.context.auxData as { isDefault?: boolean } | undefined;
      if (aux?.isDefault === true) worlds.push(event.context.id);
    };
    session.on("Runtime.executionContextCreated", onContext);
    await session.send("Runtime.enable");
    session.off("Runtime.executionContextCreated", onContext);
    for (const contextId of worlds) {
      const found = await session
        .send("Runtime.evaluate", { expression: `globalThis.${key}`, contextId })
        .catch(() => undefined);
      if (found?.result.subtype === "node" && found.result.objectId !== undefined) {
        const { node } = await session.send("DOM.describeNode", {
          objectId: found.result.objectId,
        });
        return { session, backendNodeId: node.backendNodeId };
      }
    }
  } catch (cause) {
    void session.detach().catch(constVoid);
    throw cause;
  }
  void session.detach().catch(constVoid);
  return undefined;
};

/**
 * Puts files into a file input (or the one its label names) with a single CDP call after the gate.
 * Playwright's setter prepares the files and the frame after any check made before it, so a cut
 * could still let it land. A framed input gets the same single call on its frame's session.
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
    // A main-frame input resolves on the tab's session; a framed one's global is not there.
    const found = await cdp.send("Runtime.evaluate", { expression: `globalThis.${key}` });
    const objectId = found.result.subtype === "node" ? found.result.objectId : undefined;
    if (objectId !== undefined) {
      const { node } = await cdp.send("DOM.describeNode", { objectId });
      gate();
      await cdp.send("DOM.setFileInputFiles", {
        files: [...paths],
        backendNodeId: node.backendNodeId,
      });
      return;
    }
    const framed = await framedInput(handle, key);
    if (framed === undefined)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "GOAT could not reach this file input's frame, so nothing was uploaded.",
      );
    try {
      gate();
      await framed.session.send("DOM.setFileInputFiles", {
        files: [...paths],
        backendNodeId: framed.backendNodeId,
      });
    } finally {
      void framed.session.detach().catch(constVoid);
    }
  } finally {
    // The global lives in whichever frame owns the input; deleting it there is the frame's own call.
    await handle
      .evaluate((_element, name) => {
        delete (globalThis as unknown as Record<string, unknown>)[name];
      }, key)
      .catch(constVoid);
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

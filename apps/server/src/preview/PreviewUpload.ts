// @effect-diagnostics nodeBuiltinImport:off - Playwright callbacks run outside the Effect runtime.

import type { PreviewAutomationUploadInput } from "@goat/contracts";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { CDPSession, ElementHandle, Frame, Page } from "playwright-core";
import type { ActionChannel } from "./actionChannel.ts";

import {
  DEFAULT_TIMEOUT_MS,
  type DispatchGate,
  elementOf,
  ServerBrowserOperationError,
  targetLocator,
} from "./ServerBrowserPage.ts";

/**
 * A fresh session on the process that runs `frame`: its own when it is out of process, else the
 * nearest ancestor's that is, else the page's. A same-site child of a cross-site frame shares that
 * frame's process, so the page's session cannot see it.
 */
const sessionFor = async (frame: Frame, channel: ActionChannel): Promise<CDPSession> => {
  for (let current: Frame | null = frame; current !== null; current = current.parentFrame()) {
    const session = await channel.newCDPSession(current).catch(() => null);
    if (session !== null) return session;
  }
  return channel.newCDPSession(frame.page());
};

/**
 * The input stashed under `key` in a child frame's page world, on a session for the process that
 * runs that frame. Its frames are listed by turning Runtime on in that session alone, so no
 * session the tab keeps changes state.
 */
const framedInput = async (handle: ElementHandle, key: string, channel: ActionChannel) => {
  const frame = await channel.ownerFrame(handle);
  if (frame === null) return undefined;
  const session = await sessionFor(frame, channel);
  try {
    const worlds: Array<number> = [];
    const onContext = (event: {
      readonly context: { readonly id: number; readonly auxData?: unknown };
    }) => {
      const aux = event.context.auxData as { isDefault?: boolean } | undefined;
      if (aux?.isDefault === true) worlds.push(event.context.id);
    };
    session.on("Runtime.executionContextCreated", onContext);
    await channel.sendFor(session)("Runtime.enable");
    session.off("Runtime.executionContextCreated", onContext);
    for (const contextId of worlds) {
      const found = await channel
        .sendFor(session)("Runtime.evaluate", { expression: `globalThis.${key}`, contextId })
        .catch(() => undefined);
      if (found?.result.subtype === "node" && found.result.objectId !== undefined) {
        const { node } = await channel.sendFor(session)("DOM.describeNode", {
          objectId: found.result.objectId,
        });
        return { session, backendNodeId: node.backendNodeId };
      }
    }
  } catch (cause) {
    void channel.detach(session).catch(constVoid);
    throw cause;
  }
  void channel.detach(session).catch(constVoid);
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
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for upload.");
  const send = channel.sendFor(cdp);
  const key = `__goatUploadTarget_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  let stashed = false;
  try {
    await gate();
    gate.signal?.throwIfAborted();
    const multiple = (await channel.evaluate(
      handle,
      (element: { tagName: string }, name: string) => {
        type FileInput = {
          tagName?: string;
          type?: string;
          multiple?: boolean;
          disabled?: boolean;
        };
        const target = (
          element.tagName === "LABEL"
            ? (element as unknown as { control: unknown }).control
            : element
        ) as FileInput | null;
        if (target?.tagName !== "INPUT" || target.type !== "file" || target.disabled) return null;
        (globalThis as unknown as Record<string, unknown>)[name] = target;
        return target.multiple === true;
      },
      key,
    )) as boolean | null;
    stashed = multiple !== null;
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
    const found = await send("Runtime.evaluate", { expression: `globalThis.${key}` });
    const objectId = found.result.subtype === "node" ? found.result.objectId : undefined;
    if (objectId !== undefined) {
      const { node } = await send("DOM.describeNode", { objectId });
      await send("DOM.setFileInputFiles", {
        files: [...paths],
        backendNodeId: node.backendNodeId,
      });
      return;
    }
    const framed = await framedInput(handle, key, channel);
    if (framed === undefined)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "GOAT could not reach this file input's frame, so nothing was uploaded.",
      );
    try {
      await channel.sendFor(framed.session)("DOM.setFileInputFiles", {
        files: [...paths],
        backendNodeId: framed.backendNodeId,
      });
    } finally {
      void channel.detach(framed.session).catch(constVoid);
    }
  } finally {
    // The global lives in whichever frame owns the input; deleting it there is the frame's own call.
    if (stashed)
      await channel
        .evaluate(
          handle,
          (_element: unknown, name: string) => {
            delete (globalThis as unknown as Record<string, unknown>)[name];
          },
          key,
        )
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
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for upload.");
  const handle = await elementOf(locator, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, gate.signal);
  try {
    await uploadInto(cdp, handle, input.paths, gate);
  } finally {
    if (!gate.signal?.aborted) void channel.dispose(handle).catch(constVoid);
  }
  return true;
};

/** Check all paths before any file input or picker can receive them. */
export const validatePaths = async (paths: readonly string[]) => {
  for (const path of paths) {
    if (!NodePath.isAbsolute(path))
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Upload paths must be absolute: ${path}`,
        { beforeInput: true },
      );
    await NodeFSP.access(path).catch(() => {
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Upload file not found or not readable: ${path}`,
        { beforeInput: true },
      );
    });
  }
};

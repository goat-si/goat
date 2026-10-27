/** @module ComputerUseDriverWatch */
import type { ComputerUseDriverEndReason } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { exitReason } from "./ComputerUseDriverExit.ts";

export type DriverWatchReport =
  | { readonly driverEnded: false }
  | {
      readonly driverEnded: {
        readonly reason: ComputerUseDriverEndReason;
        readonly exitCode?: number;
      };
    };

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requestId = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const MAX_TRACKED_CALLS = 64;

/**
 * Each child proves its route with its own initialize exchange, including replayed wire IDs, and
 * then an answered tool call: a driver that crashes on its first capture still answers the
 * handshake. Any ending the proxy did not ask for is reported, before or after that.
 */
export const makeDriverWatch = () => {
  let initialized = false;
  let working = false;
  let ended = false;
  let stopping = false;
  const pending = new Map<string, string>();
  const calls = new Set<string>();
  return {
    sent: (line: string) => {
      if (working || stopping || ended) return;
      const decoded = decodeMessage(line);
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      if (
        message.jsonrpc !== "2.0" ||
        !requestId(message.id) ||
        Object.hasOwn(message, "result") ||
        Object.hasOwn(message, "error")
      )
        return;
      if (message.method === "tools/call") {
        // A resumed child replays its handshake without waiting for it, so calls follow at once.
        if ((initialized || pending.size > 0) && calls.size < MAX_TRACKED_CALLS)
          calls.add(JSON.stringify(message.id));
        return;
      }
      if (
        message.method !== "initialize" ||
        !record(message.params) ||
        !nonempty(message.params.protocolVersion)
      )
        return;
      pending.set(JSON.stringify(message.id), message.params.protocolVersion);
    },
    received: (line: string): DriverWatchReport | undefined => {
      if (working || stopping || ended) return undefined;
      const decoded = decodeMessage(line);
      if (Option.isNone(decoded)) return undefined;
      const message = decoded.value;
      if (!requestId(message.id) || Object.hasOwn(message, "method")) return undefined;
      const key = JSON.stringify(message.id);
      if (calls.delete(key)) {
        if (!initialized || message.jsonrpc !== "2.0" || !Object.hasOwn(message, "result"))
          return undefined;
        working = true;
        calls.clear();
        return { driverEnded: false };
      }
      const version = pending.get(key);
      if (version === undefined) return undefined;
      // A failed reply consumes the request too; a later success needs a new initialize send.
      pending.delete(key);
      const result = message.result;
      if (
        message.jsonrpc !== "2.0" ||
        Object.hasOwn(message, "error") ||
        !record(result) ||
        result.protocolVersion !== version ||
        !record(result.capabilities) ||
        !record(result.serverInfo) ||
        !nonempty(result.serverInfo.name) ||
        !nonempty(result.serverInfo.version)
      )
        return undefined;
      initialized = true;
      pending.clear();
      return undefined;
    },
    stopping: () => {
      stopping = true;
      pending.clear();
      calls.clear();
    },
    exited: (code: number | undefined): DriverWatchReport | undefined => {
      if (ended || stopping) return undefined;
      ended = true;
      pending.clear();
      calls.clear();
      return {
        driverEnded: {
          reason: exitReason(code),
          ...(code === undefined ? {} : { exitCode: code }),
        },
      };
    },
  };
};

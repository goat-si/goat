import type { PiRpcRecord } from "./rpc.ts";

export function makeEarlyNativeWork() {
  let active = false;
  const events: PiRpcRecord[] = [];
  return {
    capture(event: PiRpcRecord): "pass" | "buffered" | "overflow" {
      if (event["type"] === "agent_start") active = true;
      if (!active || event["type"] === "response" || String(event["type"]).startsWith("t3."))
        return "pass";
      if (
        event["type"] === "extension_ui_request" &&
        ["select", "confirm", "input", "editor", "setStatus"].includes(String(event["method"]))
      )
        return "pass";
      if (events.length >= 1024) return "overflow";
      events.push(event);
      return "buffered";
    },
    hasPending: () => events.length > 0,
    drain() {
      active = false;
      return events.splice(0);
    },
  };
}

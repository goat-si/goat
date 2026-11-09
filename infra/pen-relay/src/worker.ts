import { isNodeId } from "@goat/pen-protocol/identity";
import type { Env } from "./limits.ts";

export { Room } from "./room.ts";

const ROUTE = /^\/v1\/(node|client)\/([^/]*)$/;

// A room is created where its first request lands unless hinted. Workers on workers.dev can be
// served far from the caller (Korea is often routed to LAX), so place it by the caller's continent.
function locationHint(
  cf: IncomingRequestCfProperties | undefined,
): DurableObjectLocationHint | undefined {
  switch (cf?.continent) {
    case "AS":
    case "OC":
      return "apac";
    case "EU":
    case "AF":
      return "weur";
    case "SA":
      return "sam";
    case "NA":
      return Number(cf.longitude) < -100 ? "wnam" : "enam";
    default:
      return undefined;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json(
        { ok: true, version: "pen-relay/1.0" },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const match = ROUTE.exec(url.pathname);
    const nodeId = match?.[2];
    if (nodeId === undefined) return new Response("not found", { status: 404 });
    if (!isNodeId(nodeId)) return new Response("bad node id", { status: 400 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const hint = locationHint(request.cf);
    const id = env.ROOM.idFromName(nodeId);
    return env.ROOM.get(id, hint === undefined ? undefined : { locationHint: hint }).fetch(request);
  },
} satisfies ExportedHandler<Env>;

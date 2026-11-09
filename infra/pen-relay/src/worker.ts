import { isNodeId } from "@goat/pen-protocol/identity";
import type { Env } from "./limits.ts";

export { Room } from "./room.ts";

const ROUTE = /^\/v1\/(node|client)\/([^/]*)$/;

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
    return env.ROOM.get(env.ROOM.idFromName(nodeId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

import { withSocketHeartbeat } from "../socketHeartbeat.ts";
import { requestUrl } from "../requestUrl.ts";
import {
  SOCKET_FRAME_PARTS_QUERY_PARAM,
  splitLargeSocketFrames,
} from "@goat/shared/socketFrameParts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

export const WS_RPC_SERVER_OPTIONS = { disableTracing: true, disableFatalDefects: true } as const;

export function withSocketFrameParts<A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  program: Effect.Effect<A, E, R>,
) {
  const url = requestUrl(request);
  const splitFrames =
    url._tag === "Some" && url.value.searchParams.has(SOCKET_FRAME_PARTS_QUERY_PARAM);
  return program.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      Object.create(request, {
        upgrade: {
          value: Effect.map(request.upgrade, (socket) =>
            withSocketHeartbeat(splitFrames ? splitLargeSocketFrames(socket) : socket),
          ),
        },
      }),
    ),
  );
}

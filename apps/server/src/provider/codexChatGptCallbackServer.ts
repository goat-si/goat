// @effect-diagnostics nodeBuiltinImport:off - The OAuth loopback listener is a raw Node server.
import * as NodeHttp from "node:http";

import { guardErrors } from "@goat/shared/errorGuards";

/** Listens on a free loopback port. An error before listening rejects; any server error ends the sign-in. */
export const listenForCallback = (
  answer: NodeHttp.RequestListener,
  onServerError: (error: Error) => void,
) =>
  new Promise<NodeHttp.Server>((resolve, reject) => {
    const server = guardErrors(NodeHttp.createServer(answer), (error) => {
      reject(error);
      onServerError(error);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

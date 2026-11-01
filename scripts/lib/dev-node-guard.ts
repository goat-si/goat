/**
 * Imported first by the dev runner, and run before the server's package dev
 * watcher, so an unsupported Node stops dev before anything else loads.
 */
import { currentUnsupportedNodeMessage } from "./node-runtime.ts";

const message = currentUnsupportedNodeMessage("vp run dev");
if (message !== undefined) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

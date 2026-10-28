import { DIAGNOSTIC_BUFFER_LIMIT } from "./ServerBrowserPage.ts";

export const pushBounded = <A>(buffer: Array<A>, entry: A, limit = DIAGNOSTIC_BUFFER_LIMIT) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

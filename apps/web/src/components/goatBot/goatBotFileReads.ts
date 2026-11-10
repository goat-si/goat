import type { EnvironmentId } from "@goat/contracts";

// The server reads one Library file per connection at a time; a closed viewer's or card's last
// chunk request can still be running there, so the next read on that server waits for it
// instead of hearing "busy".
const lastChunkRequest = new Map<EnvironmentId, Promise<unknown>>();

export function afterLastChunkRequest<T>(environmentId: EnvironmentId, request: () => Promise<T>) {
  const next = (lastChunkRequest.get(environmentId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(request);
  lastChunkRequest.set(environmentId, next);
  const forget = () => {
    if (lastChunkRequest.get(environmentId) === next) lastChunkRequest.delete(environmentId);
  };
  next.then(forget, forget);
  return next;
}

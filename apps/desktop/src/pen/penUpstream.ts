// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Adapts subprocess streams with an idle deadline.
import * as NodeStream from "node:stream";
import { HUB_PROXY_NODE_SCOPE_CEILING } from "@goat/contracts";
import {
  ResponseParser,
  serializeRequest,
  type HeaderList,
  type RequestHead,
  type ResponseEvent,
} from "@goat/pen-protocol/client/http1";

export interface UpstreamPipe {
  readonly stdout: NodeStream.Readable;
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly kill: () => Promise<void>;
}

export async function exchangePenResponse(
  pipe: UpstreamPipe,
  head: RequestHead,
  onEvent: (event: ResponseEvent) => Promise<void>,
  options: {
    readonly body?: AsyncIterable<Uint8Array>;
    readonly bodyCap?: number;
    readonly upgrade?: {
      readonly key: string;
      readonly protocol?: string;
      readonly headers: HeaderList;
    };
  } = {},
) {
  const upgrade = options.upgrade;
  const parser = new ResponseParser({
    method: head.method,
    bodyCap: options.bodyCap ?? Number.MAX_SAFE_INTEGER,
    ...(upgrade
      ? {
          upgrade: {
            key: upgrade.key,
            ...(upgrade.protocol ? { protocol: upgrade.protocol } : {}),
          },
        }
      : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      pipe.stdout.destroy();
      void pipe.kill();
    }, 120_000);
    timer.unref();
  };
  refresh();
  try {
    await pipe.write(serializeRequest(head, upgrade ? upgrade.headers : [["Connection", "close"]]));
    if (options.body)
      for await (const bytes of options.body) {
        refresh();
        await pipe.write(bytes);
      }
    let complete = false;
    const deliver = async (events: ResponseEvent[]) => {
      for (const event of events) {
        await onEvent(event);
        if (event.type === "end") complete = true;
      }
    };
    for await (const chunk of pipe.stdout.iterator({ destroyOnReturn: false })) {
      refresh();
      const events = parser.push(chunk as Uint8Array);
      await deliver(events);
      if (complete) return { leftover: parser.leftover() };
    }
    await deliver(parser.finish());
    if (!complete) throw new Error("Pen response ended before completion");
    return { leftover: parser.leftover() };
  } finally {
    clearTimeout(timer);
  }
}

export async function mintPenSession(pipe: UpstreamPipe) {
  const body = Buffer.from(JSON.stringify({ kind: "proxy", scopes: HUB_PROXY_NODE_SCOPE_CEILING }));
  let status = 0;
  const chunks: Buffer[] = [];
  await exchangePenResponse(
    pipe,
    {
      method: "POST",
      target: "/api/pen/session",
      host: "goat",
      headers: [["content-type", "application/json"]],
      bodyLength: body.length,
    },
    async (event) => {
      if (event.type === "head") status = event.status;
      if (event.type === "body") chunks.push(Buffer.from(event.bytes));
    },
    {
      body: (async function* () {
        yield body;
      })(),
      bodyCap: 8192,
    },
  );
  if (status !== 200) throw new Error("Pen session refused");
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Pen session");
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "proxy" ||
    typeof record.token !== "string" ||
    !record.token ||
    /[\r\n]/.test(record.token) ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    !Array.isArray(record.scopes) ||
    record.scopes.length !== HUB_PROXY_NODE_SCOPE_CEILING.length ||
    new Set(record.scopes).size !== HUB_PROXY_NODE_SCOPE_CEILING.length ||
    !record.scopes.every(
      (scope: unknown) =>
        typeof scope === "string" &&
        HUB_PROXY_NODE_SCOPE_CEILING.some((allowed) => allowed === scope),
    )
  )
    throw new Error("Invalid Pen session");
  return { token: record.token, expiresAt: Date.parse(record.expiresAt) };
}

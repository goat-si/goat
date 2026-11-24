import { ProviderDriverKind } from "@goat/contracts";
import { ProviderAdapterProtocolError } from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { CodexTurnStartParamsWithCollaborationMode } from "./CodexTurnStartParams.ts";

type Context = NonNullable<CodexTurnStartParamsWithCollaborationMode["additionalContext"]>;
type Entry = { readonly key: string; readonly text: string };
export const sendCodexSteerContext = Effect.fn("Codex.steerAppContext")(function* <E, R>(
  contexts: Ref.Ref<Map<string, Context>>,
  threadId: string,
  entries: ReadonlyArray<Entry>,
  send: (notes: Array<{ type: "text"; text: string }>) => Effect.Effect<unknown, E, R>,
) {
  const sent = (yield* Ref.get(contexts)).get(threadId);
  const notes = entries.filter(
    (entry) => entry.key !== "goat_memory" && sent?.[entry.key]?.value !== entry.text,
  );
  if (
    notes.length > 64 ||
    notes.reduce(
      (bytes, entry) => bytes + Buffer.byteLength(entry.key) + Buffer.byteLength(entry.text),
      0,
    ) >
      256 * 1024
  ) {
    return yield* new ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("codex"),
      detail: "MCP app context exceeds the Codex steer limit.",
    });
  }
  yield* send(
    notes.map((entry) => ({
      type: "text" as const,
      text: `<external_${entry.key.replace(/[^\w.-]/g, "_")}>${entry.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</external_${entry.key.replace(/[^\w.-]/g, "_")}>`,
    })),
  );
  if (notes.length)
    yield* Ref.update(contexts, (current) => {
      const next = new Map(current);
      const updated = {
        ...current.get(threadId),
        ...Object.fromEntries(
          notes.map((entry) => [entry.key, { kind: "untrusted" as const, value: entry.text }]),
        ),
      };
      const appKeys = Object.keys(updated).filter((key) => key.startsWith("mcp_app_"));
      let bytes = appKeys.reduce(
        (sum, key) => sum + Buffer.byteLength(key) + Buffer.byteLength(updated[key]?.value ?? ""),
        0,
      );
      while (appKeys.length > 64 || bytes > 256 * 1024) {
        const oldest = appKeys.shift();
        if (oldest === undefined) break;
        bytes -= Buffer.byteLength(oldest) + Buffer.byteLength(updated[oldest]?.value ?? "");
        delete updated[oldest];
      }
      next.set(threadId, updated);
      return next;
    });
});

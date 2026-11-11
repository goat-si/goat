// @effect-diagnostics globalFetchInEffect:off preferSchemaOverJson:off -- Bounds and cancels native fetch before decoding.
import {
  isSecretReference,
  TextGenerationError,
  type ServerSettings,
  type TextGeneratorConfig,
} from "@goat/contracts";
import * as TextGenerationOperations from "@goat/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import { cachedResolveSecret } from "../secrets/secretResolver.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 8;
const TIMEOUT = "120 seconds";
let activeRequests = 0;

class ApiStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("model API request failed");
    this.status = status;
  }
}

function statusDetail(status: number): string {
  if (status === 401 || status === 403) return "The model API rejected its credential.";
  if (status === 404) return "The model API could not find the endpoint or model.";
  if (status === 429) return "The model API is rate-limiting requests.";
  return `The model API returned HTTP ${status}.`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_RESPONSE_BYTES);
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      buffer.set(item.value, bytes - item.value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder().decode(buffer.subarray(0, bytes)));
}

function replyText(kind: TextGeneratorConfig["kind"], value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (kind === "openaiCompatible") {
    if (!("choices" in value) || !Array.isArray(value.choices)) return null;
    const choice = value.choices[0];
    if (!choice || choice.finish_reason === "length") return null;
    return typeof choice.message?.content === "string" ? choice.message.content : null;
  }
  if (
    !("content" in value) ||
    !Array.isArray(value.content) ||
    ("stop_reason" in value && value.stop_reason === "max_tokens")
  )
    return null;
  return (
    value.content
      .flatMap((part: unknown) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("") || null
  );
}

export const apiTextGeneration = (
  config: TextGeneratorConfig,
  secretProviders: ServerSettings["secretProviders"],
) => {
  const run: TextGenerationOperations.Runner = (request) => {
    const failure = (detail = "The configured model API could not generate text.") =>
      new TextGenerationError({
        operation: request.operation,
        detail,
      });
    return Effect.tryPromise({
      try: async (signal) => {
        if (activeRequests >= MAX_CONCURRENT_REQUESTS) throw new Error("model API is busy");
        activeRequests++;
        try {
          if (
            Buffer.byteLength(request.prompt, "utf8") > MAX_PROMPT_BYTES ||
            request.modelSelection.model.length > 256
          )
            throw new Error("request too large");
          const key = isSecretReference(config.apiKey)
            ? await cachedResolveSecret(secretProviders, config.apiKey)
            : config.apiKey;
          signal.throwIfAborted();
          const base = config.baseUrl.replace(/\/+$/, "");
          const anthropic = config.kind === "anthropic";
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (anthropic) {
            headers["x-api-key"] = key;
            headers["anthropic-version"] = "2023-06-01";
          } else if (key) headers["authorization"] = `Bearer ${key}`;
          const response = await fetch(`${base}${anthropic ? "/messages" : "/chat/completions"}`, {
            method: "POST",
            headers,
            redirect: "error",
            signal,
            body: JSON.stringify({
              model: request.modelSelection.model,
              ...(anthropic ? { max_tokens: 8192 } : {}),
              messages: [{ role: "user", content: request.prompt }],
            }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new ApiStatusError(response.status);
          }
          const text = replyText(config.kind, await readBoundedJson(response));
          if (!text) throw new Error("API returned no text");
          return text;
        } finally {
          activeRequests--;
        }
      },
      catch: (cause) =>
        failure(cause instanceof ApiStatusError ? statusDetail(cause.status) : undefined),
    }).pipe(
      Effect.timeout(TIMEOUT),
      Effect.catchTags({ TimeoutError: () => Effect.fail(failure("The model API timed out.")) }),
      Effect.flatMap((text) =>
        TextGenerationOperations.decodeJsonReply(request, "The configured model API", text).pipe(
          Effect.mapError(() => failure("The model API returned invalid structured output.")),
        ),
      ),
    );
  };
  return TextGenerationOperations.fromRunner(
    "TextGeneratorApi",
    TextGenerationOperations.withoutInvestigation("The configured model API", run),
  );
};

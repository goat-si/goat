import {
  AuthStandardClientScopes,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_SESSION_PATH,
  RuntimeSessionRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { formatIssuedPairingCredential, formatIssuedSession } from "./cliAuthFormat.ts";
import { parseDurationInput } from "./durationInput.ts";
import { isLoopbackHostname } from "./http.ts";
import * as RuntimeControl from "./runtimeControl.ts";

const refuse = (status: number, message: string) =>
  HttpServerResponse.json({ message }, { status });

/**
 * Issues a session or pairing credential for an SSH client attaching to this running server.
 * Whoever can read `runtime-control.token` can already read this server's database, so this
 * grants nothing `goat auth` on the host could not; it only keeps a CLI of another version
 * from opening the live database. The answer is what `goat auth ... --json` prints.
 */
export const layer = HttpRouter.add(
  "POST",
  GOAT_RUNTIME_SESSION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const control = yield* RuntimeControl.RuntimeControl;
    const peer = Option.getOrUndefined(request.remoteAddress);
    if (
      peer === undefined ||
      !isLoopbackHostname(peer) ||
      !control.authenticate(request.headers[GOAT_RUNTIME_CONTROL_HEADER])
    )
      return yield* refuse(
        403,
        "Runtime sessions require a loopback peer and runtime control token.",
      );
    const decoded = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RuntimeSessionRequest)),
      Effect.result,
    );
    if (decoded._tag === "Failure") return yield* refuse(400, "Invalid runtime session request.");
    const input = decoded.success;
    const ttl = input.ttl === undefined ? undefined : parseDurationInput(input.ttl);
    if (ttl === null) return yield* refuse(400, "Invalid runtime session ttl.");
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const body =
      input.kind === "session"
        ? formatIssuedSession(
            yield* auth.issueSession({
              subject: input.subject,
              scopes: [...new Set(input.scopes)],
              ...(ttl === undefined ? {} : { ttl }),
              ...(input.label === undefined ? {} : { label: input.label }),
              ...(input.runtimeModeCeiling === undefined
                ? {}
                : { runtimeModeCeiling: input.runtimeModeCeiling }),
            }),
            { json: true },
          )
        : formatIssuedPairingCredential(
            yield* auth.createPairingLink({
              scopes: AuthStandardClientScopes,
              subject: "one-time-token",
              ...(ttl === undefined ? {} : { ttl }),
              ...(input.label === undefined ? {} : { label: input.label }),
            }),
            { json: true },
          );
    yield* Effect.logInfo("runtime.session.issued", {
      kind: input.kind,
      ...(input.kind === "session" ? { subject: input.subject, scopes: input.scopes } : {}),
    });
    return HttpServerResponse.text(body, { contentType: "application/json" });
  }).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      error._tag === "ReservedAuthSubjectError"
        ? refuse(400, "That session subject is reserved.")
        : Effect.logWarning("runtime.session.failed", { cause: error }).pipe(
            Effect.andThen(refuse(500, "The server could not issue a credential.")),
          ),
    ),
  ),
);

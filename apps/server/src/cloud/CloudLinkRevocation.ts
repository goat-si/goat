import * as DateTime from "effect/DateTime";
import * as Schedule from "effect/Schedule";
import * as Crypto from "effect/Crypto";
import * as HttpClient from "effect/http/HttpClient";
import { CLOUD_WITHDRAWAL_FENCE } from "./config.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as Client from "./CloudLinkRevocationClient.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const JOURNAL = "cloud-link-withdrawal-journal";
const Entry = Schema.Struct({
  phase: Schema.Literals(["local_pending", "local_complete", "ack_pending"]),
  relayUrl: Schema.String,
  credential: Schema.String,
  environmentId: Schema.String,
  revocationId: Schema.optionalKey(Schema.String),
});
type Entry = typeof Entry.Type;
const Journal = Schema.fromJsonString(Schema.Array(Entry));
const encode = Schema.encodeSync(Journal);
const decode = Schema.decodeUnknownEffect(Journal);
const text = new TextDecoder();
const bytes = new TextEncoder();
const TRUST_KEYS = [
  CLOUD_LINKED_USER_ID,
  RELAY_URL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  CLOUD_MINT_PUBLIC_KEY,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  CLOUD_LINK_REVOKED,
  CLOUD_CLI_DESIRED_LINK_SECRET,
];

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const runtime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const cooldowns = new Map<string, number>();
  const send = Effect.fn("CloudLinkRevocation.send")(function* (target: Client.CleanupTarget) {
    if ((cooldowns.get(target.relayUrl) ?? 0) > (yield* DateTime.now).epochMilliseconds)
      return yield* new Client.CloudLinkRevocationError({ phase: "transport" });
    return yield* Client.request(target).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.retryAtMillis !== undefined)
            cooldowns.set(target.relayUrl, error.retryAtMillis);
        }),
      ),
    );
  });
  const read = Effect.gen(function* () {
    const value = yield* secrets.get(JOURNAL);
    return Option.isSome(value) ? yield* decode(text.decode(value.value)) : [];
  });
  const write = (entries: ReadonlyArray<Entry>) =>
    entries.length ? secrets.set(JOURNAL, bytes.encode(encode(entries))) : secrets.remove(JOURNAL);
  const withdrawUnlocked = Effect.fn("CloudLinkRevocation.withdrawUnlocked")(function* (
    expectedCredential?: string,
    revocationId?: string,
  ) {
    const entries = yield* read;
    let entry = entries.find((value) => value.phase === "local_pending");
    const credential = yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
    if (
      entry &&
      ((expectedCredential !== undefined && expectedCredential !== entry.credential) ||
        (Option.isSome(credential) && text.decode(credential.value) !== entry.credential))
    )
      return yield* new Client.CloudLinkRevocationError({ phase: "local_cleanup" });
    if (!entry) {
      if (
        expectedCredential !== undefined &&
        (Option.isNone(credential) || text.decode(credential.value) !== expectedCredential)
      )
        return false;
      const relay = yield* secrets.get(RELAY_URL_SECRET);
      entry = {
        phase: "local_pending",
        relayUrl: Option.isSome(relay) ? text.decode(relay.value) : "",
        credential: Option.isSome(credential) ? text.decode(credential.value) : "",
        environmentId: yield* environment.getEnvironmentId,
        ...(revocationId ? { revocationId } : {}),
      };
    }
    const captured = entry;
    const next = [...entries.filter((value) => value.phase !== "local_pending"), captured];
    const persisted = yield* write(next).pipe(Effect.result);
    const withdrawn = yield* auth.withdrawCloudCredentials().pipe(Effect.result);
    if (withdrawn._tag === "Failure")
      return yield* new Client.CloudLinkRevocationError({
        phase: "local_cleanup",
        cause: withdrawn.failure,
      });
    if (persisted._tag === "Failure")
      return yield* new Client.CloudLinkRevocationError({
        phase: "local_cleanup",
        cause: persisted.failure,
      });
    // Pending cloud grants rely on host-link trust; withdraw it before the trust secrets disappear.
    yield* auth
      .setCloudLinkTrust(null)
      .pipe(
        Effect.mapError(
          (cause) => new Client.CloudLinkRevocationError({ phase: "local_cleanup", cause }),
        ),
      );
    yield* runtime.applyConfig(null);
    yield* Effect.forEach(TRUST_KEYS, (key) => secrets.remove(key), { discard: true });
    const remaining = next.filter((value) => value !== captured);
    // Journal settlement must survive a crash before admission can reopen.
    yield* write([
      ...remaining,
      { ...captured, phase: captured.revocationId ? "ack_pending" : "local_complete" },
    ]);
    yield* auth.completeCloudWithdrawal();
    if (!captured.revocationId) yield* write(remaining);
    return true;
  });
  const withdrawInstalledLink = Effect.fn("CloudLinkRevocation.withdrawInstalledLink")(
    (expectedCredential?: string, revocationId?: string) =>
      runtime.withLinkStateLock(withdrawUnlocked(expectedCredential, revocationId)),
  );
  const resumeLocal = runtime.withLinkStateLock(
    Effect.gen(function* () {
      const entries = yield* read;
      if (entries.some((entry) => entry.phase === "local_pending")) yield* withdrawUnlocked();
      else {
        const settled = entries.some(
          (entry) => entry.phase === "local_complete" || entry.phase === "ack_pending",
        );
        if (Option.isSome(yield* secrets.get(CLOUD_WITHDRAWAL_FENCE))) {
          const installedTrust = yield* Effect.forEach(TRUST_KEYS, (key) => secrets.get(key));
          if (settled && installedTrust.every(Option.isNone)) yield* auth.completeCloudWithdrawal();
          else yield* withdrawUnlocked();
        }
        if (entries.some((entry) => entry.phase === "local_complete"))
          yield* write(entries.filter((entry) => entry.phase !== "local_complete"));
      }
    }),
  );
  const reconcile = Effect.fn("CloudLinkRevocation.reconcile")(function* () {
    yield* resumeLocal;
    const entries = yield* read;
    for (const entry of entries.filter((entry) => entry.phase === "ack_pending")) {
      const acknowledged = yield* send(entry).pipe(Effect.result);
      if (acknowledged._tag === "Failure") {
        yield* Effect.logDebug("GOAT Connect cleanup acknowledgment remains pending");
        continue;
      }
      yield* runtime.withLinkStateLock(
        Effect.gen(function* () {
          yield* write(
            (yield* read).filter((current) => current.revocationId !== entry.revocationId),
          );
        }),
      );
    }
    const installed = yield* runtime.withLinkStateLock(
      Effect.gen(function* () {
        const credential = yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
        const relay = yield* secrets.get(RELAY_URL_SECRET);
        return Option.isSome(credential) && Option.isSome(relay)
          ? {
              credential: text.decode(credential.value),
              relayUrl: text.decode(relay.value),
              environmentId: yield* environment.getEnvironmentId,
            }
          : null;
      }),
    );
    if (!installed) return;
    const receipt = yield* send(installed);
    if (receipt) yield* withdrawInstalledLink(installed.credential, receipt.revocationId);
  });
  const pending = Effect.gen(function* () {
    if ((yield* read).some((entry) => entry.phase === "local_pending")) return true;
    return Option.isSome(yield* secrets.get(CLOUD_WITHDRAWAL_FENCE));
  });
  const start = reconcile().pipe(
    Effect.catchCause(() => Effect.logWarning("GOAT Connect cleanup is unconfirmed")),
    Effect.repeat(Schedule.spaced("5 minutes")),
    Effect.forkScoped,
  );
  const unlink = withdrawInstalledLink().pipe(
    Effect.as({ ok: true as const, endpointRuntimeStatus: { status: "disabled" as const } }),
  );
  return { withdrawInstalledLink, resumeLocal, reconcile, pending, start, unlink };
});

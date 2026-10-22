import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { SshPreflightReport, SSH_PREFLIGHT_STEP_ORDER } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { RuntimePublishedSearch, RuntimeReleaseHead } from "./runtimeAvailability.ts";
import type { RemoteGoatRunnerOptions } from "./tunnel.ts";
import { runPreflightProcess } from "./preflightProcess.ts";
import { runSshPreflight } from "./preflight.ts";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";
import stderr from "./fixtures/preflight-stderr.json" with { type: "json" };

const isReport = Schema.is(SshPreflightReport);
const facts =
  "GOAT_OS=Linux\nGOAT_ARCH=aarch64\nGOAT_FREE_KIB=1048576\nGOAT_FACTS_DONE=yes\nGOAT_INSTALLED=0.1.0\n";
const fixture = (
  input: {
    handshake?: string;
    auth?: string;
    authExitCode?: number;
    facts?: string;
    factsHome?: string;
    exactReleaseAbsent?: boolean;
    none?: boolean;
    alias?: boolean | string;
    resolvedHost?: string;
    ownerLabel?: string;
    user?: string;
    host?: string;
    runner?: RemoteGoatRunnerOptions;
    settings?: string;
    missingFingerprint?: boolean;
    port?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const calls: ReadonlyArray<string>[] = [];
    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let publishedSearches = 0;
    const publishedExcludes: Array<ReadonlySet<string> | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
        calls.push(command.args);
        if (command.args[0] === "release")
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.make(new TextEncoder().encode("release not found")),
          };
        if (command.args.includes("-G")) {
          if (command.args.at(-1) === "bastion") return makeSuccessfulProcess("proxyjump none\n");
          return makeSuccessfulProcess(
            `hostname ${input.resolvedHost ?? input.host ?? "build.example"}\nuser ${input.user ?? "deploy"}\nport ${input.port ?? 22}\nidentityfile /keys/id_ed25519\nproxyjump bastion\n${input.settings ?? ""}`,
          );
        }
        if (command.args.includes("-lf"))
          return makeSuccessfulProcess(`256 SHA256:${"a".repeat(43)} build.example (ED25519)\n`);
        const knownHosts = command.args.find((arg) => arg.startsWith("UserKnownHostsFile="));
        if (knownHosts) {
          const file = knownHosts.slice("UserKnownHostsFile=".length).replace(/^"|"$/gu, "");
          if (!input.missingFingerprint)
            yield* fs.writeFileString(file, "build.example ssh-ed25519 AAAA\n");
          return makeSuccessfulProcess("");
        }
        const auth = command.args.some(
          (arg) =>
            arg === "PreferredAuthentications=publickey" ||
            arg === "PreferredAuthentications=none,publickey",
        );
        const error = auth
          ? (input.auth ?? "")
          : (input.handshake ??
            stderr.keyAndPassword.replace(
              "build.example",
              input.resolvedHost ?? input.host ?? "build.example",
            ));
        const remoteFacts =
          auth && input.factsHome
            ? yield* runPreflightProcess("env", [
                `HOME=${input.factsHome}`,
                "sh",
                "-c",
                `sh -c ${command.args.at(-1)}`,
              ]).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, nativeSpawner))
            : undefined;
        return {
          ...makeSuccessfulProcess(auth ? (remoteFacts?.stdout ?? input.facts ?? facts) : ""),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(
              auth ? (input.authExitCode ?? (input.auth ? 255 : 0)) : input.none ? 0 : 255,
            ),
          ),
          stderr: Stream.make(new TextEncoder().encode(error)),
        };
      }),
    );
    const report = yield* runSshPreflight(
      { host: input.host ?? "build" },
      {
        ownerLabel: input.ownerLabel ?? "Origin",
        runner: input.runner ?? { archiveVersion: "0.1.0" },
        ...(input.alias === false
          ? {}
          : { alias: typeof input.alias === "string" ? input.alias : "build" }),
      },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(RuntimeReleaseHead, () =>
        Effect.succeed(input.exactReleaseAbsent ? "absent" : "present"),
      ),
      Effect.provideService(RuntimePublishedSearch, (input) => {
        publishedSearches++;
        publishedExcludes.push(input.exclude);
        return Effect.succeed({ found: { version: "0.2.0", channel: "stable" }, rejected: [] });
      }),
    );
    expect(isReport(report)).toBe(true);
    expect(report.steps.map((step) => step.id)).toEqual(SSH_PREFLIGHT_STEP_ORDER);
    return { report, calls, publishedSearches, publishedExcludes };
  });
it.effect(
  "resolves destination and jump once, disables sharing, uses key-only authentication and reads installed facts",
  () =>
    Effect.gen(function* () {
      const { report, calls } = yield* fixture();
      expect(report.ready).toBe(true);
      expect(report.platformKey).toBe("linux-arm64");
      expect(calls.filter((args) => args.includes("-G"))).toHaveLength(2);
      for (const args of calls) {
        expect(args).toContain("ControlMaster=no");
        expect(args).toContain("ControlPath=none");
        expect(args).toContain("BatchMode=yes");
        expect(args).toContain("UpdateHostKeys=no");
        expect(args).toContain("PermitLocalCommand=no");
        expect(args.filter((arg) => arg.startsWith("LogLevel="))).toEqual(["LogLevel=VERBOSE"]);
      }
      expect(calls[3]).toContain("PreferredAuthentications=publickey");
      const proxies = calls
        .filter((args) => !args.includes("-G"))
        .map((args) => args.find((arg) => arg.startsWith("ProxyCommand=")));
      expect(proxies[0]).toContain("bastion");
      expect(proxies[1]).toBe(proxies[0]);
      expect(report.steps[5]?.summary).toContain("already installed");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["refused", "dns", "proxy", "jumpDenied"] as const)(
  "classifies %s without contacting the destination again",
  (kind) =>
    Effect.gen(function* () {
      const { report, calls } = yield* fixture({ handshake: stderr[kind] });
      expect(report.ready).toBe(false);
      expect(report.steps[0]?.state).toBe("failed");
      expect(calls).toHaveLength(3);
      expect(
        report.steps
          .slice(1)
          .every(
            (step) =>
              step.state === "skipped" && step.summary === "Waits for the connection check.",
          ),
      ).toBe(true);
      if (kind === "refused") expect(report.steps[0]?.fix?.instruction).toContain("Remote Login");
      if (kind === "proxy") expect(report.steps[0]?.fix?.instruction).toContain("Tailscale");
      if (kind === "jumpDenied")
        expect(report.steps[0]?.summary).toContain("jump hop bastion.example");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["node", "node.tail.ts.net", "100.64.0.2", "100.127.255.254"])(
  "offers Tailscale guidance for %s",
  (host) =>
    Effect.gen(function* () {
      const { report } = yield* fixture({ host, handshake: stderr.dns });
      expect(report.steps[0]?.fix?.instruction).toContain("Tailscale");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["unknownKey", "changedKey"] as const)("stops after %s", (kind) =>
  Effect.gen(function* () {
    const { report } = yield* fixture({ handshake: stderr[kind] });
    expect(report.steps[0]?.state).toBe("passed");
    expect(report.steps[1]?.state).toBe(kind === "unknownKey" ? "needs_review" : "failed");
    if (kind === "unknownKey") expect(report.steps[1]?.fingerprint).toContain("SHA256:");
    expect(report.steps[2]?.state).toBe("skipped");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("requires a managed pin even when known_hosts already matches", () =>
  Effect.gen(function* () {
    const { report, calls } = yield* fixture({ alias: false });
    expect(report.steps[1]?.state).toBe("needs_review");
    expect(report.steps[1]?.detail).toBe(
      "This address is already in known_hosts. Approve it once so GOAT can pin it.",
    );
    expect(report.steps[1]?.fingerprint).toContain("SHA256:");
    expect(report.steps[2]?.summary).toBe("Waits for the host key check.");
    expect(calls.filter((args) => args.includes("-G"))).toHaveLength(3);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["keyAndPassword", "passwordOnly", "partial"] as const)(
  "explains %s authentication",
  (kind) =>
    Effect.gen(function* () {
      const { report } = yield* fixture({
        auth: `Offering public key: /keys/id_ed25519 SHA256:key\n${stderr[kind]}`,
      });
      expect(report.steps[2]?.state).toBe("failed");
      expect(report.steps[3]?.summary).toBe("Waits for SSH sign-in.");
      if (kind === "keyAndPassword") {
        expect(report.steps[2]?.summary).toContain("Origin's SSH keys");
        expect(report.steps[2]?.fix?.command).toContain("ssh-copy-id");
      }
      if (kind === "passwordOnly")
        expect(report.steps[2]?.fix?.instruction).toContain("PubkeyAuthentication yes");
      if (kind === "partial")
        expect(report.steps[2]?.fix?.instruction).toContain("AuthenticationMethods publickey");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not mistake bastion authentication for destination sign-in", () =>
  Effect.gen(function* () {
    const { report } = yield* fixture({
      auth: stderr.jumpAuthenticatedDestinationDenied,
      facts: "",
    });
    expect(report.ready).toBe(false);
    expect(report.steps[2]?.state).toBe("failed");
    expect(report.steps[2]?.summary).toContain("build refused Origin's SSH keys");
    expect(report.steps[2]?.fix?.command).toContain("ssh-copy-id");
    expect(report.steps.slice(3).every((step) => step.state === "skipped")).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("ignores bastion key authentication in the destination's no-key success summary", () =>
  Effect.gen(function* () {
    const { report } = yield* fixture({
      none: true,
      handshake: "Authenticated to build.example using none.",
      auth: 'Authenticated to bastion.example using "publickey".\nAuthenticated to build.example using "none".\n',
      authExitCode: 0,
    });
    expect(report.ready).toBe(true);
    expect(report.steps[2]?.summary).toBe("The host let GOAT in without a key.");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["build.example", "build", "BUILD.EXAMPLE", "[2001:db8::1]"])(
  "recognizes destination key authentication for %s even if the shell fails",
  (authenticatedHost) =>
    Effect.gen(function* () {
      const { report } = yield* fixture({
        ...(authenticatedHost.includes(":") ? { resolvedHost: "2001:0db8::1" } : {}),
        auth: `Authenticated to bastion.example using "publickey".\nAuthenticated to ${authenticatedHost} ([192.0.2.2]:22) using "publickey".\n`,
        facts: "",
      });
      expect(report.steps[2]?.state).toBe("passed");
      expect(report.steps[2]?.summary).toBe("Signed in using Origin's SSH key.");
      expect(report.steps[3]?.state).toBe("failed");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["private", "goat-private-12345678"])(
  "retains %s routing and managed pin in key registration",
  (alias) =>
    Effect.gen(function* () {
      const { report, calls } = yield* fixture({
        host: alias,
        alias,
        resolvedHost: "10.0.0.5",
        port: 2222,
        settings: `userknownhostsfile /isolated/pins/${alias}.known_hosts\n`,
        auth: `Offering public key: /keys/id_ed25519 SHA256:key\n${stderr.jumpAuthenticatedDestinationDenied.replace("build.example", "10.0.0.5")}`,
        facts: "",
      });
      expect(report.steps[2]?.state).toBe("failed");
      expect(report.steps[2]?.fix?.command).toBe(
        `ssh-copy-id -i '/keys/id_ed25519.pub' '${alias}'`,
      );
      expect(calls[3]?.at(-4)).toBe(alias);
      expect(
        calls[3]?.some((arg) => arg.startsWith("ProxyCommand=") && arg.includes("bastion")),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([
  ["goat-juns-macbook-pro-e6ef0008", "juns-macbook-pro"],
  ["my-macbook", "my-macbook"],
] as const)("names the destination for %s key refusals", ([host, displayHost]) =>
  Effect.gen(function* () {
    const { report } = yield* fixture({
      host,
      alias: host,
      resolvedHost: "juns-macbook-pro",
      ownerLabel: "jun’s Mac Studio",
      auth: `Offering public key: /keys/id_ed25519 SHA256:key\n${stderr.keyAndPassword}`,
    });
    expect(report.steps[2]?.summary).toBe(
      `${displayHost} refused jun’s Mac Studio's SSH keys; it would ask for a password, and GOAT signs in only with keys.`,
    );
    expect(report.steps[2]?.fix?.instruction).toBe(
      `Add this computer's key to ${displayHost} once: run this command in Terminal on jun’s Mac Studio, enter the password when asked, then choose Check again.`,
    );
    expect(report.steps[2]?.fix?.command).toBe(`ssh-copy-id -i '/keys/id_ed25519.pub' '${host}'`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["handshake", "auth"] as const)(
  "reports Tailscale SSH policy refusals during %s as sign-in failures",
  (stage) =>
    Effect.gen(function* () {
      const { report, calls } = yield* fixture({
        host: "goat-cursor-2-12345678",
        alias: "goat-cursor-2-12345678",
        resolvedHost: "cursor-2",
        user: "ubuntu",
        [stage]: stderr.tailscalePolicy,
      });
      expect(report.ready).toBe(false);
      expect(report.steps[0]?.state).toBe("passed");
      expect(report.steps[1]?.state).toBe("passed");
      expect(report.steps[2]).toEqual({
        id: "key_auth",
        state: "failed",
        summary: "Tailscale's SSH policy doesn't allow signing in to cursor-2 as ubuntu.",
        fix: {
          actor: "human",
          instruction:
            "Sign in as a user the policy allows, or allow ubuntu for this device in the Tailscale admin console's SSH access rules.",
        },
      });
      expect(report.steps.slice(3).every((step) => step.state === "skipped")).toBe(true);
      expect(calls).toHaveLength(stage === "handshake" ? 3 : 4);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("accepts none authentication", () =>
  Effect.gen(function* () {
    const { report } = yield* fixture({
      none: true,
      handshake: "Authenticated to build.example using none.",
    });
    expect(report.ready).toBe(true);
    expect(report.steps[2]?.summary).toBe("The host let GOAT in without a key.");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([
  ["GOAT_OS=Darwin\nGOAT_ARCH=x86_64\nGOAT_FACTS_DONE=yes\n", "does not support"],
  ["GOAT_OS=MINGW64_NT\nGOAT_ARCH=x86_64\nGOAT_FACTS_DONE=yes\n", "cygpath"],
  ["GOAT_OS=MINGW64_NT\nGOAT_ARCH=x86_64\nGOAT_CYGPATH=yes\nGOAT_FACTS_DONE=yes\n", "System32 tar"],
  ["unexpected shell output", "POSIX default shell"],
] as const)("reports unsupported or incomplete platform %s", ([facts, message]) =>
  Effect.gen(function* () {
    const { report } = yield* fixture({ facts });
    expect(report.steps[3]?.state).toBe("failed");
    expect(report.steps[3]?.summary).toContain(message);
    expect(report.steps[5]?.summary).toBe("Waits for the platform check.");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("bounds a stalled handshake with TestClock", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
        if (command.args.includes("-G"))
          return makeSuccessfulProcess("hostname build.example\nuser deploy\nport 22\n");
        yield* Deferred.succeed(entered, undefined);
        return { ...makeSuccessfulProcess(""), exitCode: Effect.never };
      }),
    );
    const fiber = yield* runSshPreflight(
      { host: "build" },
      { ownerLabel: "Origin", alias: "build", runner: {} },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(FetchHttpClient.layer),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("20 seconds");
    const report = yield* Fiber.join(fiber);
    expect(report.steps[0]?.summary).toContain("timed out");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([true, false])("low disk space blocks only a required transfer (%s)", (transfer) =>
  Effect.gen(function* () {
    const { report } = yield* fixture({
      facts: `GOAT_OS=Linux\nGOAT_ARCH=aarch64\nGOAT_FREE_KIB=1024\nGOAT_FACTS_DONE=yes\n${transfer ? "" : "GOAT_INSTALLED=0.1.0\n"}`,
    });
    expect(report.steps[4]?.state).toBe(transfer ? "failed" : "passed");
    if (transfer)
      expect(report.steps[4]?.summary).toContain("512 MB for the archive and extracted runtime");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("bounds both process streams to 64 KiB while draining the child", () =>
  Effect.gen(function* () {
    const process = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...makeSuccessfulProcess("a".repeat(200_000)),
        stderr: Stream.make(new TextEncoder().encode("b".repeat(200_000))),
      }),
    );
    const output = yield* runPreflightProcess("ssh", []).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process),
    );
    expect(output.exitCode).toBe(0);
    expect(output.stdout.length).toBe(64 * 1024);
    expect(output.stderr.length).toBe(64 * 1024);
  }),
);

it.effect.each([
  ["2001:db8::1", "2001:db8::1"],
  ["2001:db8::1", "[2001:db8::1]"],
  ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
] as const)("recognizes IPv6 destination %s reported as %s", ([host, diagnostic]) =>
  Effect.gen(function* () {
    const { report, calls } = yield* fixture({
      host,
      handshake: `deploy@${diagnostic}: Permission denied (publickey,password).`,
    });
    expect(report.ready).toBe(true);
    expect(report.steps[0]?.state).toBe("passed");
    expect(report.steps[2]?.state).toBe("passed");
    expect(calls).toHaveLength(4);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["2001:db8::2", "[2001:db8::2]"])("attributes IPv6 jump-hop %s", (hop) =>
  Effect.gen(function* () {
    const { report, calls } = yield* fixture({
      host: "2001:db8::1",
      handshake: `jump@${hop}: Permission denied (publickey,password).`,
    });
    expect(report.steps[0]?.state).toBe("failed");
    expect(report.steps[0]?.summary).toContain(`jump hop ${hop} failed`);
    expect(report.steps[2]?.state).toBe("skipped");
    expect(calls).toHaveLength(3);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["oracle.tail.ts.net", "100.64.0.1", "100.127.255.254"])(
  "explains no-key Tailscale sign-in for %s",
  (host) =>
    Effect.gen(function* () {
      const { report } = yield* fixture({
        host,
        none: true,
        handshake: `Authenticated to ${host} using none.`,
      });
      expect(report.ready).toBe(true);
      expect(report.steps[2]?.summary).toBe("Signed in through Tailscale SSH; no key needed.");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["clisu-oracle", "100.63.255.255", "100.128.0.0", "public.example"])(
  "does not call non-Tailscale none authentication Tailscale for %s",
  (host) =>
    Effect.gen(function* () {
      const { report } = yield* fixture({
        host,
        none: true,
        handshake: `Authenticated to ${host} using none.`,
      });
      expect(report.steps[2]?.summary).toBe("The host let GOAT in without a key.");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("formats disk space in human units and only counts incremental installation space", () =>
  Effect.gen(function* () {
    const { report } = yield* fixture({ facts: facts.replace("1048576", String(156652 * 1024)) });
    expect(report.steps[4]?.summary).toBe("153 GB free in the home folder.");
    const low = yield* fixture({
      facts: facts.replace("1048576", "1024").replace("GOAT_INSTALLED=0.1.0", ""),
    });
    expect(low.report.steps[4]?.summary).toBe(
      "Only 1 MB free; installing GOAT needs 512 MB for the archive and extracted runtime.",
    );
    expect(low.report.steps[4]?.fix?.instruction).toContain("512 MB");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fingerprint review keeps every SSH stage read-only", () =>
  Effect.gen(function* () {
    const { report, calls } = yield* fixture({ handshake: stderr.unknownKey });
    expect(report.steps[1]?.state).toBe("needs_review");
    for (const args of calls.filter((args) => !args.includes("-lf"))) {
      expect(args).toContain("UpdateHostKeys=no");
      expect(args).toContain("PermitLocalCommand=no");
      expect(args).toContain("ControlMaster=no");
      expect(args).toContain("ControlPath=none");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "none authentication overrides configured commands, forwarding and TTY on every probe",
  () =>
    Effect.gen(function* () {
      const { report, calls } = yield* fixture({
        none: true,
        handshake: "Authenticated to build.example using none.",
        settings: "remotecommand touch /mutated\nrequesttty force\nlocalforward 8080 target:80\n",
      });
      expect(report.ready).toBe(true);
      expect(calls[2]?.slice(-3)).toEqual(["build", "exit", "0"]);
      for (const args of calls.filter((args) => !args.includes("-G"))) {
        for (const option of [
          "-T",
          "RemoteCommand=none",
          "RequestTTY=no",
          "ClearAllForwardings=yes",
          "ForwardAgent=no",
          "ForwardX11=no",
        ])
          expect(args).toContain(option);
      }
      expect(calls[3]).toContain("sh");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("fingerprint collection failure gives actionable guidance instead of review", () =>
  Effect.gen(function* () {
    const { report } = yield* fixture({ alias: false, missingFingerprint: true });
    expect(report.steps[1]?.state).toBe("failed");
    expect(report.steps[1]?.fingerprint).toBeUndefined();
    expect(report.steps[1]?.fix?.instruction).toContain("negotiated destination host key");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("fingerprint probes also terminate none-auth sessions and override remote commands", () =>
  Effect.gen(function* () {
    const { report, calls } = yield* fixture({
      alias: false,
      none: true,
      settings: "remotecommand touch /mutated\n",
    });
    expect(report.steps[1]?.state).toBe("needs_review");
    const probe = calls.find((args) => args.includes("StrictHostKeyChecking=accept-new"))!;
    expect(probe.slice(-3)).toEqual(["build", "exit", "0"]);
    for (const option of [
      "-T",
      "RemoteCommand=none",
      "RequestTTY=no",
      "ClearAllForwardings=yes",
      "ForwardAgent=no",
      "ForwardX11=no",
    ])
      expect(probe).toContain(option);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps low disk as a warning when a different runtime may be reused despite an available release",
  () =>
    Effect.gen(function* () {
      const { report } = yield* fixture({
        facts:
          "GOAT_OS=Linux\nGOAT_ARCH=aarch64\nGOAT_FREE_KIB=1024\nGOAT_FACTS_DONE=yes\nGOAT_INSTALLED=0.2.0\n",
      });
      expect(report.steps[5]?.state).toBe("passed");
      expect(report.steps[5]?.summary).toContain("Downloads the published GOAT 0.1.0");
      expect(report.steps[4]?.state).toBe("warning");
      expect(report.steps[4]?.summary).toContain("1 MB free");
      expect(report.steps[4]?.summary).toContain("installed runtime cannot be reused");
      expect(report.ready).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("provides key creation and alias-based installation when no local key exists", () =>
  Effect.gen(function* () {
    const { report } = yield* fixture({
      auth: stderr.keyAndPassword,
      host: "build",
      alias: "build",
      user: "deploy'account",
      port: 2222,
    }).pipe(Effect.provideService(HostProcess.HomeDirectory, "/isolated owner"));
    expect(report.steps[2]?.fix?.command).toBe(
      "ssh-keygen -t ed25519 && ssh-copy-id -i '/isolated owner/.ssh/id_ed25519.pub' 'build'",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  ["statev2.sqlite", false],
  ["state.sqlite", false],
  ["statev2.sqlite", true],
  ["state.sqlite", true],
  [undefined, false],
] as const)("remote facts guard fallback for %s (symlink %s)", ([database, symlink]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preflight-data-" });
    if (database) {
      yield* fs.makeDirectory(`${home}/.goat/userdata`, { recursive: true });
      const file = `${home}/.goat/userdata/${database}`;
      if (symlink) yield* fs.symlink(`${home}/missing-database`, file);
      else yield* fs.writeFileString(file, "");
    }
    const { report, publishedSearches } = yield* fixture({
      factsHome: home,
      exactReleaseAbsent: true,
      runner: { archiveVersion: "0.1.0", publishedFallback: true },
    });
    const runtime = report.steps.find((step) => step.id === "runtime");
    expect(runtime?.state).toBe(database ? "failed" : "passed");
    expect(runtime?.summary).toContain(
      database ? "build has GOAT data but no runtime" : "GOAT installs 0.2.0",
    );
    expect(publishedSearches).toBe(database ? 0 : 1);
    expect(report.ready).toBe(!database);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("a published fallback still requires space to install", () =>
  Effect.gen(function* () {
    const { report, publishedSearches } = yield* fixture({
      facts: facts.replace("GOAT_INSTALLED=0.1.0", "").replace("1048576", "1024"),
      exactReleaseAbsent: true,
      runner: { archiveVersion: "0.1.0", publishedFallback: true },
    });
    expect(publishedSearches).toBe(1);
    expect(report.steps.find((step) => step.id === "runtime")?.state).toBe("passed");
    expect(report.steps.find((step) => step.id === "disk")?.state).toBe("failed");
    expect(report.ready).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["pending", "rejected"] as const)(
  "refuses a held-only %s fallback when the host has GOAT data",
  (held) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preflight-held-" });
      const runtime = `${home}/.goat/runtime/goat`;
      yield* fs.makeDirectory(`${runtime}/versions/0.2.0`, { recursive: true });
      yield* fs.writeFileString(`${runtime}/versions/0.2.0/goat`, "");
      yield* fs.chmod(`${runtime}/versions/0.2.0/goat`, 0o755);
      yield* fs.writeFileString(`${runtime}/versions/0.2.0/.install-complete`, "0.2.0");
      yield* fs.makeDirectory(`${runtime}/held`);
      yield* fs.writeFileString(`${runtime}/held/0.2.0`, held);
      yield* fs.makeDirectory(`${home}/.goat/userdata`);
      yield* fs.writeFileString(`${home}/.goat/userdata/statev2.sqlite`, "");
      const { report, publishedSearches } = yield* fixture({
        factsHome: home,
        exactReleaseAbsent: true,
        runner: { archiveVersion: "0.1.0", publishedFallback: true },
      });
      expect(report.steps.find((step) => step.id === "runtime")?.state).toBe("failed");
      expect(report.steps.find((step) => step.id === "runtime")?.summary).toContain(
        "build has GOAT data but no runtime",
      );
      expect(publishedSearches).toBe(0);
      expect(report.ready).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a rejected nightly does not bypass stable fallback lookup or disk enforcement", () =>
  Effect.gen(function* () {
    const nightly = "0.2.0-nightly.1";
    const { report, publishedSearches, publishedExcludes } = yield* fixture({
      facts: facts
        .replace("1048576", "1024")
        .replace(
          "GOAT_INSTALLED=0.1.0",
          `GOAT_INSTALLED=${nightly}\nGOAT_HELD=${nightly}:rejected`,
        ),
      exactReleaseAbsent: true,
      runner: { archiveVersion: "0.1.0", publishedFallback: true },
    });
    const runtime = report.steps.find((step) => step.id === "runtime");
    expect(runtime?.state).toBe("passed");
    expect(runtime?.summary).toContain("GOAT installs 0.2.0");
    expect(publishedSearches).toBe(1);
    expect(publishedExcludes).toEqual([new Set([nightly])]);
    expect(report.steps.find((step) => step.id === "disk")?.state).toBe("failed");
    expect(report.ready).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

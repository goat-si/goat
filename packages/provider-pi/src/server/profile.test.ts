import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveOmoSessionsDir } from "./profile.ts";

it.effect("resolves OmO session and agent directory precedence", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = {
      OMO_CODING_AGENT_SESSION_DIR: "/session",
      SENPI_CODING_AGENT_SESSION_DIR: "/ignored",
      OMO_CODING_AGENT_DIR: "/omo",
      SENPI_CODING_AGENT_DIR: "/senpi",
      PI_CODING_AGENT_DIR: "/pi",
    };
    assert.equal(resolveOmoSessionsDir(env, "/home", path, "/settings"), "/session");
    assert.equal(
      resolveOmoSessionsDir(
        { ...env, OMO_CODING_AGENT_SESSION_DIR: "" },
        "/home",
        path,
        "/settings",
      ),
      "/settings",
    );
    assert.equal(
      resolveOmoSessionsDir({ ...env, OMO_CODING_AGENT_SESSION_DIR: "" }, "/home", path),
      "/omo/sessions",
    );
    assert.equal(
      resolveOmoSessionsDir(
        { SENPI_CODING_AGENT_DIR: "/senpi", PI_CODING_AGENT_DIR: "/pi" },
        "/home",
        path,
      ),
      "/senpi/sessions",
    );
    assert.equal(
      resolveOmoSessionsDir({ PI_CODING_AGENT_DIR: "/pi" }, "/home", path),
      "/pi/sessions",
    );
    assert.equal(resolveOmoSessionsDir({}, "/home", path), "/home/.omo/agent/sessions");
    assert.equal(
      resolveOmoSessionsDir({ OMO_CODING_AGENT_DIR: "~/omo" }, "/home", path),
      "/home/omo/sessions",
    );
  }).pipe(Effect.provide(NodePath.layer)),
);

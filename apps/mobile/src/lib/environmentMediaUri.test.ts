import { BearerConnectionTarget, SshConnectionTarget } from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

const connection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: { get: () => connection.value } }));
vi.mock("../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => null },
  usePreparedConnection: () => connection.value,
}));

import { routeMobileMediaUrl } from "./environmentMediaUri";

const environmentId = EnvironmentId.make("remote");
const remote = { environmentId, label: "Build box" };

it("opens a tapped localhost document at the environment's address, or refuses with the reason", () => {
  connection.value = Option.some({
    httpBaseUrl: "http://100.65.180.100:3773",
    target: new BearerConnectionTarget({ ...remote, connectionId: "saved:box" }),
  });
  expect(routeMobileMediaUrl(environmentId, "http://localhost:5173/report.pdf")).toEqual({
    _tag: "Open",
    url: "http://100.65.180.100:5173/report.pdf",
  });
  connection.value = Option.some({
    httpBaseUrl: "http://127.0.0.1:41234",
    target: new SshConnectionTarget({ ...remote, connectionId: "ssh:box" }),
  });
  expect(routeMobileMediaUrl(environmentId, "http://localhost:5173/report.pdf")).toMatchObject({
    _tag: "Unreachable",
    reason: expect.stringContaining("localhost:5173 is on Build box"),
  });
});

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

import { mediaRouteKey, mobileMediaConnection, routeMobileMediaUrl } from "./environmentMediaUri";

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
it("moves an image's route key only for loopback URLs when the connection changes", () => {
  const tailnet = mobileMediaConnection(
    Option.some({
      httpBaseUrl: "http://100.65.180.100:3773",
      target: new BearerConnectionTarget({ ...remote, connectionId: "saved:box" }),
    }),
  );
  const ssh = mobileMediaConnection(
    Option.some({
      httpBaseUrl: "http://127.0.0.1:41234",
      target: new SshConnectionTarget({ ...remote, connectionId: "ssh:box" }),
    }),
  );
  const keys = (href: string) => [mediaRouteKey(tailnet, href), mediaRouteKey(ssh, href)];
  const [tailnetKey, sshKey] = keys("http://localhost:5173/shot.png");
  expect(tailnetKey).toBe("http://100.65.180.100:5173/shot.png");
  expect(sshKey).not.toBe(tailnetKey);
  for (const href of ["https://cdn.example.com/a.png", "/repo/shots/a.png", "shots/a.png"]) {
    const [first, second] = keys(href);
    expect(first).toBe(second);
  }
});

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import {
  SshConnectionProfile,
  SshConnectionTarget,
  PrimaryConnectionTarget,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { catalogToImportInput } from "./hubNodesImport.logic";

function entry(alias = "host", label = " Host "): ConnectionCatalogEntry {
  const environmentId = EnvironmentId.make("env-test");
  return {
    target: new SshConnectionTarget({ environmentId, connectionId: alias, label }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId,
        connectionId: alias,
        label,
        target: { alias, hostname: "example.com", username: "jun", port: 2222 },
      }),
    ),
    enabled: true,
  };
}
function profiles(entries: ConnectionCatalogEntry[]) {
  const input = catalogToImportInput(entries);
  if (input.catalog.state !== "readable") throw new Error("Expected readable catalog");
  return input.catalog.profiles;
}
describe("catalogToImportInput", () => {
  it("preserves target overrides and alternate SSH routes", () => {
    const first = entry();
    const alternate = entry("backup");
    expect(profiles([{ ...first, alternateRoutes: [alternate] }])).toEqual([
      {
        environmentId: first.target.environmentId,
        label: "Host",
        ssh: { alias: "host", hostname: "example.com", username: "jun", port: 2222 },
      },
      {
        environmentId: first.target.environmentId,
        label: "Host",
        ssh: { alias: "backup", hostname: "example.com", username: "jun", port: 2222 },
      },
    ]);
  });
  it("skips disabled, cloud aliases, primary and platform entries including alternate routes", () => {
    const first = entry();
    const primary = new PrimaryConnectionTarget({
      environmentId: first.target.environmentId,
      label: "local",
      httpBaseUrl: "http://localhost",
      wsBaseUrl: "ws://localhost",
    });
    const platform = new BearerConnectionTarget({
      environmentId: first.target.environmentId,
      label: "WSL",
      connectionId: "local:wsl",
    });
    expect(
      profiles([
        { ...first, enabled: false },
        entry("boat-machine"),
        { ...first, target: primary },
        { ...first, alternateRoutes: [{ target: platform, profile: Option.none() }] },
      ]),
    ).toEqual([]);
  });
  it("trims labels, falls back to alias and caps labels at 120", () => {
    expect(
      profiles([entry("host", "  "), entry("long", " x".repeat(150))]).map((p) => p.label),
    ).toEqual(["host", " x".repeat(150).trim().slice(0, 120)]);
  });
  it("caps the import at 500 profiles, including alternates", () => {
    expect(
      profiles(Array.from({ length: 501 }, (_, index) => entry(`host-${index}`))),
    ).toHaveLength(500);
  });
});

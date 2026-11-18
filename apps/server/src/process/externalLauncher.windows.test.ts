import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest, windowsHost } from "./externalLauncher.testkit.ts";

describe.skipIf(!windowsHost)("Windows file manager shell", () => {
  it.live("opens Windows folders through the default shell handler", () =>
    Effect.gen(function* () {
      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "C:/workspace [draft]/author's ‘left’ ‚low‛ $media/’; Write-Output injected; #",
        });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "win32",
            env: { PATH: "C:\\Windows", PATHEXT: ".EXE" },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );
      assert.ok(spawned);
      assert.equal(spawned.options.detached, false);
      const source = Buffer.from(String(spawned.args.at(-1) ?? ""), "base64").toString("utf16le");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* spawner.string(
        ChildProcess.make(spawned.command, [
          ...spawned.args.slice(0, -1),
          Buffer.from(
            `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); function Invoke-Item { param($LiteralPath) Write-Output $LiteralPath }; ${source}`,
            "utf16le",
          ).toString("base64"),
        ]),
      );
      assert.equal(
        output.trim(),
        "C:\\workspace [draft]\\author's ‘left’ ‚low‛ $media\\’; Write-Output injected; #",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    ["none", "none", "", "C:/repo/file.txt", 'explorer.exe /select,"C:\\repo\\file.txt"'],
    ["Directory", "openindopus", "dopusrt.exe", "C:/repo/file.txt", "shell:C:\\repo"],
    ["Folder", "openindopus", "dopusrt.exe", "C:/repo/file.txt", "shell:C:\\repo"],
    [
      "Folder",
      "open",
      '"C:\\Windows\\explorer.exe"',
      "C:/repo/file.txt",
      'explorer.exe /select,"C:\\repo\\file.txt"',
    ],
    [
      "Folder",
      "open",
      "ExplorerDelegate",
      "C:/repo/file.txt",
      'explorer.exe /select,"C:\\repo\\file.txt"',
    ],
    [
      "Drive",
      "openindopus",
      "dopusrt.exe",
      "C:/repo/file.txt",
      'explorer.exe /select,"C:\\repo\\file.txt"',
    ],
    ["Drive", "openindopus", "dopusrt.exe", "C:/file.txt", "shell:C:\\"],
  ] as const)(
    "honors Windows %s/%s (%s) for %s",
    ([replacement, verb, handler, target, expected]) =>
      Effect.gen(function* () {
        let spawned: ChildProcess.StandardCommand | undefined;
        yield* Effect.gen(function* () {
          const launcher = yield* ExternalLauncher.ExternalLauncher;
          yield* launcher.launchEditor({
            editor: "file-manager",
            cwd: target,
            reveal: true,
          });
        }).pipe(
          Effect.provide(
            layerTest({
              platform: "win32",
              env: { PATH: "C:\\Windows", PATHEXT: ".EXE" },
              onSpawn: (command) => {
                spawned = command;
              },
            }),
          ),
        );
        assert.ok(spawned);
        const source = Buffer.from(String(spawned.args.at(-1) ?? ""), "base64").toString("utf16le");
        const stubs = `function Get-ItemProperty { param($LiteralPath, $ErrorAction) @{ '(default)' = if ($LiteralPath -eq 'Registry::HKEY_CLASSES_ROOT\\${replacement}\\shell') { '${verb}' } elseif ($LiteralPath -eq 'Registry::HKEY_CLASSES_ROOT\\${replacement}\\shell\\${verb}\\command') { '${handler}' } else { 'none' }; DelegateExecute = if ('${handler}' -eq 'ExplorerDelegate') { '{11dbb47c-a525-400b-9e80-a54615a090c0}' } else { '' } } }; function Invoke-Item { param($LiteralPath) Write-Output "shell:$LiteralPath" }; function Start-Process { param($FilePath, $ArgumentList) Write-Output "$FilePath $ArgumentList" }; `;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const output = yield* spawner.string(
          ChildProcess.make(spawned.command, [
            ...spawned.args.slice(0, -1),
            Buffer.from(stubs + source, "utf16le").toString("base64"),
          ]),
        );
        assert.equal(output.trim(), expected);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

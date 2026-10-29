import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const extrasList = {
  extras: [
    {
      token: "mbe:rectangle",
      owner_pid: 501,
      owner_bundle_id: "com.knollsoft.Rectangle",
      app_name: "Rectangle",
      title: "Rectangle",
      index: 0,
      frame: { x: 1200, y: 0, w: 28, h: 24 },
    },
    {
      token: "mbe:tailscale",
      owner_pid: 502,
      owner_bundle_id: "io.tailscale.ipn.macsys",
      app_name: "Tailscale",
      title: "Tailscale",
      index: 1,
      frame: { x: 1230, y: 0, w: 28, h: 24 },
    },
    {
      token: "mbe:unknown",
      owner_pid: 503,
      app_name: "MysteryExtra",
      title: "Mystery",
      index: 2,
    },
  ],
};

const openMenuReply = {
  menu_token: "menu:rectangle:1",
  elements: [
    {
      element_index: 0,
      element_token: "mitem:0",
      role: "AXMenuItem",
      label: "Left Half",
      enabled: true,
    },
    {
      element_index: 1,
      element_token: "mitem:1",
      role: "AXMenuItem",
      label: "Right Half",
      enabled: true,
    },
    {
      element_index: 2,
      element_token: "mitem:2",
      role: "AXMenuItem",
      label: "Custom Action",
      enabled: true,
    },
    {
      element_index: 3,
      element_token: "mitem:3",
      role: "AXMenuItem",
      label: "Quit Rectangle",
      enabled: true,
    },
    {
      element_index: 4,
      element_token: "mitem:4",
      role: "AXMenuItem",
      label: "Disconnect",
      enabled: true,
    },
    {
      element_index: 5,
      element_token: "mitem:5",
      role: "AXMenuItem",
      label: "종료",
      enabled: true,
    },
    {
      element_index: 6,
      element_token: "mitem:6",
      role: "AXMenuItem",
      label: "Paste",
      enabled: true,
    },
  ],
};

it.live(
  "screen.menuBarExtras lists extras, opens a menu, clicks safe items or alternate labels, refuses destructive items and unknown-bundle extras, retires old handles on relist, rechecks app scope at every action, and auto-closes unclosed menus at cell end",
  () => {
    let approvedApps: ReadonlyArray<string> | undefined = [
      "com.knollsoft.Rectangle",
      "io.tailscale.ipn.macsys",
    ];
    let failClose = false;
    const base = fixture({
      list_menu_bar_extras: () => extrasList,
      open_menu_bar_extra: () => openMenuReply,
      press_menu_item: () => ({ effect: "confirmed", evidence: ["driver:acted"] }),
      close_menu: () =>
        failClose
          ? new DriverError({ code: "close_failed" }, "menu stuck open")
          : { effect: "confirmed", evidence: ["driver:acted"] },
    });
    const leases = {
      currentControl: () => Effect.succeedSome({ controlId: "control" }),
      controlState: () =>
        Effect.succeed({
          _tag: "active" as const,
          idle: false,
          apps: approvedApps,
        }),
      releaseForeground: () => Effect.succeed(true),
    };
    const host = createDesktopTargetHost({
      primitiveChannel: base.channel as never,
      leases: leases as never,
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;

      // 1. List extras, open Rectangle, refuse Quit/Disconnect/종료, click safe item and alternate label,
      // refuse unknown-owner-bundle extra, and refuse stale handle after a new menuBarExtras() list.
      const first = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const extras = await screen.menuBarExtras();
          const rect = extras.find((e) => e.app === 'Rectangle');
          const unknown = extras.find((e) => e.app === 'MysteryExtra');
          let unknownRefused;
          try { await unknown.open(); } catch (e) { unknownRefused = e.code + ':' + e.nothingSent; }
          const menu = await rect.open();
          const blocked = [];
          for (const label of ['Quit Rectangle', 'Disconnect', '종료', 'Paste']) {
            try { await menu.click(label); blocked.push('ok'); }
            catch (e) { blocked.push(e.code + ':' + e.nothingSent); }
          }
          const clicked = await menu.click('Left Half');
          // Reopen and click an alternate label (passes as documented) then close explicitly.
          const menu2 = await rect.open();
          const alt = await menu2.click(2);
          // Relist retires the earlier rect handle.
          await screen.menuBarExtras();
          let staleHandle;
          try { await rect.open(); } catch (e) { staleHandle = e.code + ':' + e.nothingSent; }
          return {
            count: extras.length,
            unknownRefused,
            blocked,
            clicked: clicked.verdict,
            alt: alt.verdict,
            staleHandle,
          };`,
      });
      expect(first.status).toBe("completed");
      expect(first.value).toEqual({
        count: 3,
        unknownRefused: "permission_denied:true",
        blocked: [
          "permission_denied:true",
          "permission_denied:true",
          "permission_denied:true",
          "permission_denied:true",
        ],
        clicked: "confirmed",
        alt: "confirmed",
        staleHandle: "stale_reference:true",
      });

      // 2. Grant revocation between open() and click() refuses click() with permission_denied.
      const opened = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const [rect] = await screen.menuBarExtras();
          globalThis.__openMenu = await rect.open();
          await globalThis.__openMenu.close();
          globalThis.__openMenu2 = await rect.open();
          return globalThis.__openMenu2.elements.length;`,
      });
      expect(opened.value).toBe(7);
      // Cell 2 left __openMenu2 open at cell end -> auto-closed by close_menu!
      expect(base.sent.at(-1)?.tool).toBe("close_menu");

      // Narrow approvedApps so Rectangle is no longer approved; the next action on Rectangle is refused.
      approvedApps = ["io.tailscale.ipn.macsys"];
      const revoked = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `try { await globalThis.__openMenu2.click('Left Half'); return 'ok'; }
          catch (e) { return e.code + ':' + e.nothingSent; }`,
      });
      expect(revoked.value).toBe("permission_denied:true");

      // 3. When cell-end auto-close fails, the cell result records cleanup_failed in its journal
      // and the next cell's click on that menu requires reopening first.
      approvedApps = ["com.knollsoft.Rectangle", "io.tailscale.ipn.macsys"];
      failClose = true;
      const cleanupFailedCell = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const [rect] = await screen.menuBarExtras();
          globalThis.__stuckMenu = await rect.open();
          return true;`,
      });
      expect(
        cleanupFailedCell.journal.some((entry) =>
          entry.receipt.evidence.includes("cleanup_failed:close_menu"),
        ),
      ).toBe(true);

      failClose = false;
      const mustReopen = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `try { await globalThis.__stuckMenu.click(0); return 'ok'; }
          catch (e) { return e.code + ':' + e.nothingSent; }`,
      });
      expect(mustReopen.value).toBe("stale_reference:true");
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

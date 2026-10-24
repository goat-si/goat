/**
 * What the server-run Linux helper last reported (#1223). CuaDriver reads it for host status;
 * LinuxHelperHost writes it. It is its own module because the host reads CuaDriver to know when
 * the driver daemon runs.
 *
 * @module LinuxHelperReport
 */
import type { DesktopCuaReadinessReport } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export class LinuxHelperReport extends Context.Service<
  LinuxHelperReport,
  { readonly latest: Ref.Ref<Option.Option<DesktopCuaReadinessReport>> }
>()("goat/cua/linuxHelperHost/LinuxHelperReport") {}

export const layer = Layer.effect(
  LinuxHelperReport,
  Effect.map(Ref.make(Option.none<DesktopCuaReadinessReport>()), (latest) =>
    LinuxHelperReport.of({ latest }),
  ),
);

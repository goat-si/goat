// @effect-diagnostics nodeBuiltinImport:off - electron-builder invokes this hook outside Effect.
import linkLegacyLinuxExecutable from "./link-legacy-linux-executable.ts";
import macAfterPack from "./mac-after-pack.ts";
import prepareServerCompileCache from "./prepare-server-compile-cache.cjs";

export default async function desktopAfterPack(
  context: Parameters<typeof macAfterPack>[0] & {
    readonly arch: number;
    readonly packager: {
      readonly appInfo: { readonly productFilename: string };
      readonly executableName: string;
    };
  },
): Promise<void> {
  if (context.electronPlatformName === "darwin") await macAfterPack(context);
  if (context.electronPlatformName === "linux") await linkLegacyLinuxExecutable(context);
  await prepareServerCompileCache(context);
}

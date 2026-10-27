// Temporary native injection for https://github.com/nodejs/node/issues/67048.
export function resolveSeaBuildTarget(input: {
  target: string | undefined;
  platform: string;
  arch: string;
}) {
  const requested = input.target?.trim();
  const target = requested && requested !== "host" ? requested : undefined;
  const host = `${input.platform === "win32" ? "win" : input.platform}-${input.arch}`;
  const injectLinuxArm64 = (target ?? host) === "linux-arm64";
  if (injectLinuxArm64 && host !== "linux-arm64") {
    throw new Error("Linux ARM64 executables must be built on a Linux ARM64 host.");
  }
  return { target, injectLinuxArm64 };
}

import * as NodePath from "node:path";
function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseUnifiedCgroupPath(contents: string): string | undefined {
  const matches = [...contents.matchAll(/^0::(\/.*)$/gm)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function isSafeCgroupPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.includes("(deleted)") &&
    NodePath.posix.normalize(value) === value
  );
}

export function parseCgroup2Mounts(
  contents: string,
): ReadonlyArray<{ readonly mountPoint: string; readonly root: string }> {
  const mounts: Array<{ readonly mountPoint: string; readonly root: string }> = [];
  for (const line of contents.split("\n")) {
    const [mount, filesystem] = line.split(" - ");
    if (mount === undefined || filesystem?.split(" ")[0] !== "cgroup2") continue;
    const fields = mount.split(" ");
    if (fields[4] === undefined || fields[3] === undefined) continue;
    mounts.push({
      mountPoint: decodeMountInfoPath(fields[4]),
      root: decodeMountInfoPath(fields[3]),
    });
  }
  return mounts;
}

export function parseCgroup2Mount(
  contents: string,
): { readonly mountPoint: string; readonly root: string } | undefined {
  return parseCgroup2Mounts(contents)[0];
}

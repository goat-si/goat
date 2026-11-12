import type { EnvironmentMachineKind } from "@goat/contracts";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const DMI_ROOT = "/sys/class/dmi/id";
const KERNEL_RELEASE_PATH = "/proc/sys/kernel/osrelease";
const MACHINE_NONCE_FILE = "machine-nonce";
const MACHINE_NONCE_PATTERN = /^[0-9a-f]{32}$/;

// SMBIOS 3.x System Enclosure types (table 17).
const DMI_CHASSIS_KINDS: Readonly<Record<string, EnvironmentMachineKind>> = {
  "3": "desktop",
  "4": "desktop",
  "5": "desktop",
  "6": "desktop",
  "7": "desktop",
  "8": "laptop",
  "9": "laptop",
  "10": "laptop",
  "13": "desktop",
  "14": "laptop",
  "15": "desktop",
  "16": "desktop",
  "17": "server",
  "18": "server",
  "19": "server",
  "20": "server",
  "21": "server",
  "22": "server",
  "23": "server",
  "24": "server",
  "28": "server",
  "31": "laptop",
  "32": "laptop",
  "35": "desktop",
};

// VMs read as cloud regardless of chassis. Match Hyper-V's product, since Surface shares its vendor.
const VIRTUALIZATION_MARKERS = [
  "qemu",
  "kvm",
  "bochs",
  "vmware",
  "virtualbox",
  "innotek",
  "xen",
  "parallels",
  "amazon ec2",
  "google compute engine",
  "digitalocean",
  "hetzner",
  "linode",
  "vultr",
  "scaleway",
  "openstack",
  "cloud",
  "virtual machine",
];

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function machineKindFromAppleProductName(name: string): EnvironmentMachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macmini")) return "mac-mini";
  if (normalized.startsWith("macstudio")) return "mac-studio";
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) return "desktop";
  return null;
}

function machineKindFromDmi(input: {
  readonly chassisType: string | null;
  readonly sysVendor: string | null;
  readonly productName: string | null;
}): EnvironmentMachineKind | null {
  const productName = input.productName ?? "";
  const vendorAndProduct = `${input.sysVendor ?? ""} ${productName}`.toLowerCase();
  if (VIRTUALIZATION_MARKERS.some((marker) => vendorAndProduct.includes(marker))) {
    return "cloud";
  }
  const appleKind = machineKindFromAppleProductName(productName);
  if (appleKind !== null) {
    return appleKind;
  }
  return input.chassisType === null ? null : (DMI_CHASSIS_KINDS[input.chassisType] ?? null);
}

const readOptionalFile = Effect.fn("readOptionalFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.map(normalize),
    Effect.orElseSucceed(() => null),
  );
});

const runProbe = Effect.fn("runMachineProbe")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      timeout: "5 seconds",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? normalize(result.stdout) : null)),
      Effect.orElseSucceed(() => null),
    );
});

// Apple silicon exposes IOKit's marketing name; Intel needs the hw.model fallback.
const detectDarwinMachineKind = Effect.fn("detectDarwinMachineKind")(function* () {
  const ioreg = yield* runProbe({ command: "ioreg", args: ["-rd1", "-n", "product"] });
  const productName = ioreg?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
  const fromProductName =
    productName === null ? null : machineKindFromAppleProductName(productName);
  if (fromProductName !== null) {
    return fromProductName;
  }
  const model = yield* runProbe({ command: "sysctl", args: ["-n", "hw.model"] });
  return model === null ? null : machineKindFromAppleProductName(model);
});

const detectLinuxMachineKind = Effect.fn("detectLinuxMachineKind")(function* () {
  const [kernelRelease, chassisType, sysVendor, productName] = yield* Effect.all([
    readOptionalFile(KERNEL_RELEASE_PATH),
    readOptionalFile(`${DMI_ROOT}/chassis_type`),
    readOptionalFile(`${DMI_ROOT}/sys_vendor`),
    readOptionalFile(`${DMI_ROOT}/product_name`),
  ]);
  // Check WSL first; WSL 2 presents as a Hyper-V VM in DMI.
  if (kernelRelease?.toLowerCase().includes("microsoft")) {
    return "linux";
  }
  return machineKindFromDmi({ chassisType, sysVendor, productName });
});

export const detectServerEnvironmentMachineKind = Effect.fn("detectServerEnvironmentMachineKind")(
  function* () {
    const platform = yield* HostProcess.Platform;
    switch (platform) {
      case "darwin":
        return yield* detectDarwinMachineKind();
      case "linux":
        return yield* detectLinuxMachineKind();
      default:
        return null;
    }
  },
);

const readOsMachineIdentifier = Effect.fn("readOsMachineIdentifier")(function* () {
  switch (yield* HostProcess.Platform) {
    case "darwin": {
      const ioreg = yield* runProbe({
        command: "ioreg",
        args: ["-rd1", "-c", "IOPlatformExpertDevice"],
      });
      return ioreg?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
    }
    case "linux":
      return (
        (yield* readOptionalFile("/etc/machine-id")) ??
        (yield* readOptionalFile("/var/lib/dbus/machine-id"))
      );
    case "win32": {
      const reg = yield* runProbe({
        command: "reg",
        args: ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      });
      return reg?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? null;
    }
    default:
      return null;
  }
});

const hashIdentity = Effect.fn("hashServerMachineIdentity")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.orElseSucceed(() => null));
  return digest === null ? null : Hex.encode(digest).slice(0, 32);
});

/**
 * Where this server's account keeps its machine nonce: ~/.goat, shared by the desktop app's
 * server and the headless one SSH launches start. A development server keeps its own in its base
 * directory, so it never writes the live install and reads as a machine of its own.
 */
export const serverMachineNonceDirectory = Effect.fn("serverMachineNonceDirectory")(
  function* (config: { readonly devUrl: URL | undefined; readonly baseDir: string }) {
    if (config.devUrl !== undefined) return config.baseDir;
    const path = yield* Path.Path;
    return path.join(yield* HostProcess.HomeDirectory, GOAT_HOME_DIR_NAME);
  },
);

const nonceFile = Effect.fn("machineNonceFile")(function* (directory: string) {
  const path = yield* Path.Path;
  return path.join(directory, MACHINE_NONCE_FILE);
});

/** The nonce, `null` when no file exists yet, or what makes the file unusable. */
const readMachineNonce = Effect.fn("readMachineNonce")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(file).pipe(
    Effect.map((text): { readonly nonce: string } | { readonly problem: string } => {
      const nonce = text.trim();
      if (MACHINE_NONCE_PATTERN.test(nonce)) return { nonce };
      return { problem: nonce === "" ? "is empty" : "is not a GOAT nonce" };
    }),
    Effect.catch((error) =>
      Effect.succeed(
        error.reason._tag === "NotFound" ? null : { problem: "cannot be read: " + error.message },
      ),
    ),
  );
});

/**
 * A random value in the nonce directory shared by this account's servers. Images and VM forks
 * copy the OS machine identifier and often the boot id, but a clone gets its own nonce unless the
 * directory was in the image. Returns why it is unusable, which is also logged, or null.
 */
export const ensureServerMachineNonce = Effect.fn("ensureServerMachineNonce")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const file = yield* nonceFile(directory);
  // Link a complete file into place so a racing server sees nothing or the winner's nonce.
  const create = Effect.gen(function* () {
    const fresh = Hex.encode(yield* crypto.randomBytes(16));
    const staged = file + "." + fresh;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(staged, fresh + "\n");
    yield* fileSystem.link(staged, file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
      Effect.ensuring(fileSystem.remove(staged).pipe(Effect.ignore)),
    );
    return (yield* readMachineNonce(file)) ?? { problem: "was not created" };
  }).pipe(
    Effect.catch((error) => Effect.succeed({ problem: "could not be created: " + error.message })),
  );
  const result = (yield* readMachineNonce(file)) ?? (yield* create);
  if (!("problem" in result)) return null;
  yield* Effect.logWarning(
    `${file} ${result.problem}; this server cannot tell machines cloned from one image apart.`,
  );
  return result.problem;
});

/**
 * `machineId` is one value for every GOAT server on this machine, such as the desktop app's
 * server and the headless server SSH launches start in ~/.goat; `machineUserId` narrows it to one
 * OS account. Clones of one image share both, so `machineInstallId` hashes the account's nonce.
 */
export const detectServerMachineIdentity = Effect.fn("detectServerMachineIdentity")(function* (
  nonceDirectory: string,
) {
  const identifier = (yield* readOsMachineIdentifier())?.toLowerCase() ?? null;
  if (identifier === null) return { machineId: null, machineUserId: null, machineInstallId: null };
  const home = yield* HostProcess.HomeDirectory;
  const nonce = yield* readMachineNonce(yield* nonceFile(nonceDirectory));
  return {
    machineId: yield* hashIdentity("goat-machine-id:v1:" + identifier),
    machineUserId: yield* hashIdentity("goat-machine-user:v1:" + identifier + "\u0000" + home),
    machineInstallId:
      nonce !== null && "nonce" in nonce
        ? yield* hashIdentity("goat-machine-install:v1:" + nonce.nonce)
        : null,
  };
});

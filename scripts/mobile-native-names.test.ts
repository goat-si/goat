// @effect-diagnostics nodeBuiltinImport:off - Reads checked-in native sources, like the static checks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// The mobile native code is renamed and built only by store builds, so these checks prove that the
// names JS, native code, generated code and scripts use for each other still agree.
const root = NodePath.resolve(import.meta.dirname, "..");
const mobile = NodePath.join(root, "apps/mobile");
const modulesDir = NodePath.join(mobile, "modules");
const read = (path: string) => NodeFS.readFileSync(path, "utf8");

const walk = (dir: string): string[] =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "Vendor", "generated", "build", ".gradle"].includes(entry.name)
        ? []
        : walk(path);
    }
    return [path];
  });

const moduleNames = NodeFS.readdirSync(modulesDir).filter((name) =>
  NodeFS.existsSync(NodePath.join(modulesDir, name, "expo-module.config.json")),
);
const allModuleFiles = moduleNames.flatMap((name) => walk(NodePath.join(modulesDir, name)));
const sources = (extension: RegExp) => allModuleFiles.filter((path) => extension.test(path));

interface ModuleConfig {
  readonly apple?: {
    readonly modules?: readonly string[];
    readonly appDelegateSubscribers?: readonly string[];
    readonly podspecPath?: string;
  };
  readonly android?: { readonly modules?: readonly string[] };
}

const exposedApple = new Set<string>();
const exposedAndroid = new Set<string>();
const nameIn = (source: string) =>
  [...source.matchAll(/(?:@ExpoModule|\bName)\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]!);

describe("mobile native names", () => {
  it("resolves every Expo module, subscriber and podspec to its native class", () => {
    const swift = sources(/\.swift$/);
    for (const name of moduleNames) {
      const dir = NodePath.join(modulesDir, name);
      const config = JSON.parse(
        read(NodePath.join(dir, "expo-module.config.json")),
      ) as ModuleConfig;
      for (const className of [
        ...(config.apple?.modules ?? []),
        ...(config.apple?.appDelegateSubscribers ?? []),
      ]) {
        const file = swift.find((path) =>
          new RegExp(String.raw`\bclass ${className}\b`).test(read(path)),
        );
        expect(file, `${name}: Swift class ${className}`).toBeDefined();
        if (config.apple?.modules?.includes(className)) {
          for (const exposed of nameIn(read(file!))) exposedApple.add(exposed);
        }
      }
      if (config.apple?.podspecPath) {
        expect(NodeFS.existsSync(NodePath.join(dir, config.apple.podspecPath))).toBe(true);
      }
      for (const qualified of config.android?.modules ?? []) {
        const parts = qualified.split(".");
        const path = NodePath.join(
          dir,
          "android/src/main/java",
          ...parts.slice(0, -1),
          `${parts.at(-1)}.kt`,
        );
        expect(NodeFS.existsSync(path), qualified).toBe(true);
        const source = read(path);
        expect(source).toContain(`package ${parts.slice(0, -1).join(".")}`);
        for (const exposed of nameIn(source)) exposedAndroid.add(exposed);
      }
    }
    expect(exposedApple.size).toBeGreaterThan(0);
    expect(exposedAndroid.size).toBeGreaterThan(0);
  });

  it("requires only native names a module exposes", () => {
    const js = walk(NodePath.join(mobile, "src")).filter((path) => /\.tsx?$/.test(path));
    const wanted: Array<readonly [string, string]> = [];
    for (const path of js) {
      const source = read(path);
      for (const match of source.matchAll(
        /require(?:Optional)?Native(?:Module|View)\s*(?:<[\s\S]*?>)?\s*\(\s*["']([^"']+)["']/g,
      )) {
        wanted.push([path, match[1]!]);
      }
      for (const match of source.matchAll(/NATIVE_[A-Z_]+_NAME\s*=\s*["']([^"']+)["']/g)) {
        wanted.push([path, match[1]!]);
      }
    }
    const ours = wanted.filter(([, name]) => /^(?:Goat|T3)/.test(name));
    expect(ours.length).toBeGreaterThan(5);
    for (const [path, name] of ours) {
      const exposed = path.includes(".ios.")
        ? exposedApple
        : path.includes(".android.")
          ? exposedAndroid
          : new Set([...exposedApple, ...exposedAndroid]);
      expect(exposed.has(name), `${NodePath.relative(root, path)} requires ${name}`).toBe(true);
    }
  });

  it("keeps Fabric component names, codegen providers and native registrations together", () => {
    const dir = NodePath.join(modulesDir, "goat-source-text");
    const pkg = JSON.parse(read(NodePath.join(dir, "package.json"))) as {
      codegenConfig: { ios: { componentProvider: Record<string, string> } };
    };
    const providers = Object.keys(pkg.codegenConfig.ios.componentProvider);
    const components = walk(NodePath.join(dir, "src")).flatMap((path) =>
      [...read(path).matchAll(/codegenNativeComponent<[\s\S]*?>\(\s*"([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(components.toSorted()).toEqual(providers.toSorted());
    const native = walk(NodePath.join(dir, "ios"))
      .filter((path) => /\.(?:mm|h|cpp)$/.test(path))
      .map(read)
      .join("\n");
    for (const component of components) {
      expect(native).toContain("RCT_EXPORT_MODULE(" + component + ")");
      expect(native).toContain(component + "Cls(");
    }
  });

  it("links every Kotlin JNI declaration to a C++ symbol in the library it loads", () => {
    const dir = NodePath.join(modulesDir, "goat-terminal/android/src/main");
    const bridge = walk(NodePath.join(dir, "java")).find((path) =>
      path.endsWith("GhosttyBridge.kt"),
    )!;
    const kotlin = read(bridge);
    const pkg = /^package ([\w.]+)/m.exec(kotlin)![1]!;
    const cpp = sources(/_jni\.cpp$/)
      .map(read)
      .join("\n");
    const cmake = read(NodePath.join(dir, "cpp/CMakeLists.txt"));
    for (const match of kotlin.matchAll(/external fun (\w+)/g)) {
      expect(cpp).toContain(`Java_${pkg.replaceAll(".", "_")}_GhosttyBridge_${match[1]}`);
    }
    for (const match of kotlin.matchAll(/System\.loadLibrary\("([^"]+)"\)/g)) {
      if (match[1] === "ghostty-vt") continue;
      expect(cmake).toMatch(new RegExp(`add_library\\(${match[1]}\\s+SHARED`));
    }
  });

  it("resolves Android receivers, services and drawables", () => {
    for (const name of moduleNames) {
      const main = NodePath.join(modulesDir, name, "android/src/main");
      const manifest = NodePath.join(main, "AndroidManifest.xml");
      if (!NodeFS.existsSync(manifest)) continue;
      const kotlin = walk(main)
        .filter((path) => path.endsWith(".kt"))
        .map(read)
        .join("\n");
      for (const match of read(manifest).matchAll(
        /<(?:receiver|service) android:name="([^"]+)"/g,
      )) {
        const className = match[1]!.split(".").at(-1)!;
        if (match[1]!.startsWith("expo.modules.notifications")) continue;
        expect(kotlin, `${name}: ${match[1]}`).toMatch(new RegExp(`class ${className}\\b`));
      }
      for (const match of kotlin.matchAll(/(?<!android\.)R\.drawable\.(\w+)/g)) {
        expect(
          NodeFS.existsSync(NodePath.join(main, "res/drawable", `${match[1]}.xml`)),
          match[1],
        ).toBe(true);
      }
    }
    const widgetManifest = read(
      NodePath.join(modulesDir, "goat-widget-expiry/android/src/main/AndroidManifest.xml"),
    );
    expect(widgetManifest).toContain("android.intent.action.MY_PACKAGE_REPLACED");
  });

  it("matches the names scripts, plugins and web views share with native code", () => {
    const showcase = read(NodePath.join(root, "scripts/mobile-showcase.ts"));
    const nativeControls = sources(/goat-native-controls\/.*\.(?:swift|kt)$/)
      .map(read)
      .join("\n");
    for (const name of [
      "GoatShowcaseReadyScene",
      "GoatShowcaseScene",
      "goat-showcase-scene",
      "goat-showcase-ready",
    ]) {
      expect(showcase, name).toContain(name);
      expect(nativeControls, name).toContain(name);
    }
    const plugin = read(NodePath.join(mobile, "plugins/withWidgetLogoAsset.cjs"));
    const widget = read(NodePath.join(mobile, "src/widgets/AgentActivity.tsx"));
    const asset = /assetName="([^"]+)"/.exec(widget)![1]!;
    expect(plugin).toContain(`"${asset}.imageset"`);
    expect(NodeFS.existsSync(NodePath.join(mobile, "assets/widget", `${asset}.svg`))).toBe(true);
    const generator = read(NodePath.join(mobile, "scripts/generate-device-stream.mts"));
    const prefix = /name: \x60(\w+)\$\{name\}Stream\x60/.exec(generator)![1]!;
    expect(read(NodePath.join(mobile, "src/features/devices/device-stream-document.ts"))).toContain(
      `${prefix}DeviceStream`,
    );
    expect(
      read(NodePath.join(mobile, "src/features/browser/preview-stream-document.ts")),
    ).toContain(`${prefix}PreviewStream`);
    const pkg = JSON.parse(read(NodePath.join(mobile, "package.json"))) as {
      dependencies: Record<string, string>;
    };
    for (const target of Object.values(pkg.dependencies)) {
      if (target.startsWith("file:"))
        expect(NodeFS.existsSync(NodePath.join(mobile, target.slice(5))), target).toBe(true);
    }
  });
});

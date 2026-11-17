// Preloaded with --require, in argv and NODE_OPTIONS, before the server entry. A CommonJS preload
// also runs in every worker, including one evaluated from a string, and NODE_OPTIONS carries it
// into child Node processes. registerHooks covers import and require; dlopen is wrapped because
// an addon loaded by path never passes through resolve.
export const BUNDLE_SELF_CHECK_RESOLVE_HOOK = `const { existsSync, realpathSync } = require("node:fs");
const { registerHooks } = require("node:module");
const { fileURLToPath, pathToFileURL } = require("node:url");

// Node's resolver keeps the spelling a path arrived in (a Windows 8.3 name like RUNNER~1, another
// letter case), so every side is compared as the native realpath spells it. A file that has no
// such spelling never counts as inside.
const canonical = (file) => {
  try {
    const target = file.startsWith("file:") ? fileURLToPath(file) : file;
    return pathToFileURL(realpathSync.native(target)).href;
  } catch {
    return undefined;
  }
};
const treeUrl = canonical(process.env.GOAT_BUNDLE_SELF_CHECK_TREE ?? "");
if (treeUrl === undefined) throw new Error("GOAT_BUNDLE_SELF_CHECK_TREE does not name the packaged tree");
const tree = treeUrl.endsWith("/") ? treeUrl : treeUrl + "/";
// The hook lives beside the tree and is required again through argv after NODE_OPTIONS.
const self = canonical(__filename);
const inside = (url) => url !== undefined && (url.startsWith(tree) || url === self);
// Fail the way a clean machine would, so optional-dependency probes still read it as missing.
const escaped = (what, url, code) =>
  Object.assign(new Error(what + " resolved to " + url + ", outside the packaged tree " + tree), { code });

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith("file:") && !inside(canonical(resolved.url))) {
      const code = context.conditions.includes("require") ? "MODULE_NOT_FOUND" : "ERR_MODULE_NOT_FOUND";
      throw escaped(specifier, resolved.url, code);
    }
    return resolved;
  },
});

const dlopen = process.dlopen;
process.dlopen = function (module, filename, ...rest) {
  const url = canonical(filename);
  // A missing file fails in dlopen itself with its usual error; an existing one must prove it is inside.
  if (url === undefined ? existsSync(filename) : !inside(url)) {
    throw escaped(filename, url ?? filename, "ERR_DLOPEN_FAILED");
  }
  return dlopen.call(this, module, filename, ...rest);
};
`;

type Overrides = Readonly<Record<string, string | undefined>>;

/**
 * `base` with `overrides` on top, as a view instead of a copy: every read and enumeration sees the
 * base's current values, so a PATH the server learns later reaches whoever holds this object.
 * An override of `undefined` hides the base's variable. Writes and deletes stay in the view.
 */
export function overlayEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Overrides,
): NodeJS.ProcessEnv {
  const own = new Map<string, string | undefined>(Object.entries(overrides));
  // Own properties only, so a name such as "constructor" never reads as a variable.
  const read = (name: string) =>
    own.has(name) ? own.get(name) : Object.hasOwn(base, name) ? base[name] : undefined;
  const names = () => {
    const all = new Set(Object.keys(base));
    for (const name of own.keys()) all.add(name);
    return [...all].filter((name) => read(name) !== undefined);
  };
  return new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (target, name) =>
        typeof name === "string" && (own.has(name) || !(name in target))
          ? read(name)
          : Reflect.get(target, name),
      has: (target, name) =>
        typeof name === "string" ? read(name) !== undefined : Reflect.has(target, name),
      ownKeys: names,
      getOwnPropertyDescriptor: (_target, name) => {
        const value = typeof name === "string" ? read(name) : undefined;
        return value === undefined
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
      set: (_target, name, value) => {
        if (typeof name !== "string") return false;
        own.set(name, value === undefined ? undefined : String(value));
        return true;
      },
      deleteProperty: (_target, name) => {
        if (typeof name === "string") own.set(name, undefined);
        return true;
      },
    },
  );
}

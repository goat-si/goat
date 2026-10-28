export const definitionName = (ref: string) =>
  /^#\/\$defs\/(.+)$/.exec(ref)?.[1]?.replaceAll("~1", "/").replaceAll("~0", "~");

interface ExactPackageSpec {
  readonly name: string;
  readonly version: string;
}

export function parseNpxPackageSpec(packageSpec: string): ExactPackageSpec {
  const separator = packageSpec.lastIndexOf("@");
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + 1).replace(/^v/iu, ""),
  };
}

export function parseUvxPackageSpec(packageSpec: string): ExactPackageSpec {
  const equalsSeparator = packageSpec.lastIndexOf("==");
  const separator = equalsSeparator >= 0 ? equalsSeparator : packageSpec.lastIndexOf("@");
  const separatorLength = equalsSeparator >= 0 ? 2 : 1;
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + separatorLength).replace(/^v/iu, ""),
  };
}

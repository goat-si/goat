declare function prepareServerCompileCache(context: {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly arch: number;
  readonly packager: {
    readonly appInfo: { readonly productFilename: string };
    readonly executableName: string;
  };
}): Promise<void>;
export = prepareServerCompileCache;

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const root = new URL("../../", import.meta.url);
const repository = new URL("../../../../", import.meta.url);

async function appGuideLinks(directory: string): Promise<string[]> {
  const links: string[] = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-electron", ".astro", ".expo", ".git"].includes(entry.name))
      continue;
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      links.push(...(await appGuideLinks(path)));
    } else if (/\.(?:[cm]?[jt]sx?|astro)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      const source = await NodeFSP.readFile(path, "utf8");
      for (const match of source.matchAll(/https:\/\/trygoat\.ai\/docs\/user\/([^\s"'`<>]*)/g)) {
        const target = match[1]!;
        if (!target.includes("${")) {
          links.push(target);
        } else {
          expect(target, `Unhandled computed docs link in ${path}`).toBe("${guidance.guide}");
          const guides = [...source.matchAll(/\bguide:\s*["']([^"']+)["']/g)];
          expect(guides.length, `No guidance values in ${path}`).toBeGreaterThan(0);
          links.push(...guides.map((guide) => guide[1]!));
        }
      }
    }
  }
  return links;
}

it("rebuilds the marketing site when only a user guide changes", async () => {
  const workflow = await NodeFSP.readFile(
    new URL(".github/workflows/marketing-pages.yml", repository),
    "utf8",
  );
  const paths = workflow.match(/^    paths:\n((?:      - .+\n)+)/m)?.[1];
  expect(paths).toBeDefined();
  const patterns = paths!
    .trim()
    .split("\n")
    .map((line) => line.trim().slice(2));
  for (const name of await NodeFSP.readdir(new URL("docs/user/", repository))) {
    if (!name.endsWith(".md")) continue;
    const changedFile = `docs/user/${name}`;
    expect(
      patterns.some((pattern) => NodePath.matchesGlob(changedFile, pattern)),
      changedFile,
    ).toBe(true);
  }
});

it("publishes every source guide and resolves all app docs links and rendered guide links under either site base", async () => {
  const links = (
    await Promise.all(
      ["apps", "packages"].map((path) =>
        appGuideLinks(NodeURL.fileURLToPath(new URL(path, repository))),
      ),
    )
  ).flat();
  expect(links.length).toBeGreaterThanOrEqual(3);
  const slugs = (await NodeFSP.readdir(new URL("docs/user/", repository)))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));
  const output = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-user-docs-test-"));
  try {
    for (const base of ["/", "/goat/"]) {
      const outDir = new URL(`file://${output}/${base === "/" ? "root" : "preview"}/`);
      NodeChildProcess.execFileSync(
        process.execPath,
        ["node_modules/astro/bin/astro.mjs", "build", "--outDir", NodeURL.fileURLToPath(outDir)],
        {
          cwd: root,
          env: {
            ...process.env,
            MARKETING_BASE_PATH: base,
            BASE_URL: base,
            NODE_ENV: "production",
            MARKETING_SITE_URL: "https://trygoat.ai",
          },
          stdio: "pipe",
        },
      );
      const pages = new Map<string, string>();
      for (const slug of ["", ...slugs]) {
        const path = `docs/user/${slug ? `${slug}/` : ""}`;
        const html = await NodeFSP.readFile(new URL(`${path}index.html`, outDir), "utf8");
        pages.set(`${base}${path}`, html);
        expect(html.match(/<h1(?:\s|>)/g), path).toHaveLength(1);
        expect(html, path).not.toContain(`${base}ko/docs/user`);
      }
      for (const target of links) {
        const [slug, anchor] = target.split("#");
        const html = pages.get(`${base}docs/user/${slug}/`);
        expect(html, target).toBeDefined();
        if (anchor) expect(html, target).toContain(`id="${anchor}"`);
      }
      const marketingPages = await Promise.all(
        ["", "ko/", "privacy-policy/", "ko/privacy-policy/"].map(
          async (path) =>
            [
              `${base}${path}`,
              await NodeFSP.readFile(new URL(`${path}index.html`, outDir), "utf8"),
            ] as const,
        ),
      );
      for (const [path, html] of [...pages, ...marketingPages]) {
        for (const match of html.matchAll(/href="([^"]+)"/g)) {
          const url = new URL(match[1]!, `https://trygoat.ai${path}`);
          if (url.origin !== "https://trygoat.ai" || !url.pathname.includes("/docs/user/"))
            continue;
          expect(url.pathname, `${path} → ${url.pathname}`).toMatch(
            new RegExp(`^${base}docs/user/`),
          );
          const destination = pages.get(url.pathname);
          expect(destination, `${path} → ${url.pathname}`).toBeDefined();
          if (url.hash)
            expect(destination, `${path} → ${url.href}`).toContain(
              `id="${decodeURIComponent(url.hash.slice(1))}"`,
            );
        }
        expect(html, path).not.toMatch(/href="(?:\.\/)?[^"/]+\.md(?:#|"|\?)/);
      }
      expect(pages.get(`${base}docs/user/install/`)).toContain("<table>");
      expect(pages.get(`${base}docs/user/install/`)).toContain("<pre");
      expect(pages.get(`${base}docs/user/goat-connect-troubleshooting/`)).toContain(
        'id="the-tunnel-works-but-t3-code-does-not-answer"',
      );
      const sitemap = await NodeFSP.readFile(new URL("sitemap.xml", outDir), "utf8");
      for (const path of pages.keys())
        expect(sitemap).toContain(`<loc>https://trygoat.ai${path}</loc>`);
    }
  } finally {
    await NodeFSP.rm(output, { recursive: true, force: true });
  }
});

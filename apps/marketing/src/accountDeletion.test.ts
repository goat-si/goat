import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vite-plus/test";
import EnglishDeletion from "./pages/account/delete.astro";
import KoreanDeletion from "./pages/ko/account/delete.astro";
import Legal from "./components/Legal.astro";

it.each([
  {
    locale: "en",
    page: EnglishDeletion,
    path: "/account/delete",
    title: "Delete GOAT Connect account",
  },
  {
    locale: "ko",
    page: KoreanDeletion,
    path: "/ko/account/delete",
    title: "GOAT Connect 계정 삭제",
  },
] as const)(
  "$locale public deletion page links directly to authenticated deletion without an app install",
  async ({ locale, page, path, title }) => {
    const container = await AstroContainer.create({ astroConfig: { site: "https://trygoat.ai" } });
    const html = await container.renderToString(page, {
      request: new Request(`https://trygoat.ai${path}`),
    });
    expect(html).toContain(title);
    expect(html).toMatch(/href="https:\/\/app\.trygoat\.ai\/account\/delete"/);
    const legal = await container.renderToString(Legal, { props: { locale } });
    expect(legal).toContain(`href="${path}/"`);
  },
);

/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** "1" builds the review preview: noindex everywhere and a robots.txt that disallows crawling. */
  readonly MARKETING_NOINDEX: string;
}

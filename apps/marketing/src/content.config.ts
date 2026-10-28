import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  userGuides: defineCollection({
    loader: glob({ pattern: "*.md", base: "../../docs/user" }),
  }),
};

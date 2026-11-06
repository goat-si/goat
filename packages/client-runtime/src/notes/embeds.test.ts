import { describe, expect, it } from "vite-plus/test";
import { classifyNoteEmbed, noteFileRef, resolveNoteFilePath } from "./embeds.ts";

const file = ".attachments/0123456789abcdef.png";

describe("note embed paths", () => {
  it("resolves attachment references relative to the note's folder", () => {
    expect(resolveNoteFilePath("plan.md", file)).toBe(file);
    expect(resolveNoteFilePath("ideas/plan.md", `../${file}`)).toBe(file);
    expect(resolveNoteFilePath("ideas/plan.md", `/${file}`)).toBe(file);
    expect(resolveNoteFilePath("plan.md", `./${file}`)).toBe(file);
    expect(resolveNoteFilePath("plan.md", "%2Eattachments/0123456789abcdef.png")).toBe(file);
  });

  it("reaches nothing but the attachment folder", () => {
    for (const src of [
      "../.attachments/0123456789abcdef.png",
      "other.md",
      ".git/config",
      "ideas/.attachments/0123456789abcdef.png",
      "https://example.com/.attachments/0123456789abcdef.png",
      "file:///etc/passwd",
      "//example.com/x.png",
      "%E0%A4%A.png",
    ])
      expect(resolveNoteFilePath("plan.md", src)).toBeNull();
  });

  it("writes references that survive moving the note between folders", () => {
    for (const notePath of ["plan.md", "ideas/plan.md"])
      expect(resolveNoteFilePath(notePath, noteFileRef(file))).toBe(file);
  });
});

describe("note embed kinds", () => {
  it("shows media by extension and other attachments as files", () => {
    expect(classifyNoteEmbed("plan.md", file, "image")).toEqual({ kind: "image", file, url: null });
    const video = ".attachments/0123456789abcdef.mp4";
    expect(classifyNoteEmbed("plan.md", video, "image")).toMatchObject({
      kind: "video",
      file: video,
    });
    const pdf = ".attachments/0123456789abcdef.pdf";
    expect(classifyNoteEmbed("plan.md", pdf, "image")).toMatchObject({ kind: "file", file: pdf });
    expect(classifyNoteEmbed("plan.md", pdf, "link", "Spec.pdf")).toEqual({
      kind: "file",
      file: pdf,
      name: "Spec.pdf",
    });
    expect(classifyNoteEmbed("plan.md", "https://example.com/a.webm", "image")).toMatchObject({
      kind: "video",
      url: "https://example.com/a.webm",
    });
  });

  it("builds players only from recognized video URLs", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    ])
      expect(classifyNoteEmbed("plan.md", url, "url")).toMatchObject({
        kind: "player",
        provider: "YouTube",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      });
    expect(classifyNoteEmbed("plan.md", "https://vimeo.com/76979871", "autolink")).toMatchObject({
      kind: "player",
      embedUrl: "https://player.vimeo.com/video/76979871",
    });
    expect(
      classifyNoteEmbed("plan.md", `https://www.loom.com/share/${"a".repeat(32)}`, "link"),
    ).toMatchObject({ kind: "player", embedUrl: `https://www.loom.com/embed/${"a".repeat(32)}` });
    for (const url of [
      "https://www.youtube.com/watch?v=short",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    ])
      expect(classifyNoteEmbed("plan.md", url, "url").kind).toBe("link");
  });

  it("shows other web links as cards and leaves anything else alone", () => {
    expect(classifyNoteEmbed("plan.md", "https://example.com/docs?q=1", "url")).toEqual({
      kind: "link",
      url: "https://example.com/docs?q=1",
      host: "example.com",
      path: "/docs?q=1",
    });
    for (const src of ["data:image/png;base64,AAAA", "other.md", "mailto:a@example.com"])
      expect(classifyNoteEmbed("plan.md", src, "image").kind).toBe("unsupported");
  });
});

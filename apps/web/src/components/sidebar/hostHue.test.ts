import { expect, it } from "vite-plus/test";
import { assignSidebarHostHues } from "../Sidebar.logic";

it("preserves the existing device-to-color assignment", () => {
  expect(
    Object.fromEntries(
      assignSidebarHostHues([
        "juns-macbook-pro",
        "juns-mac-studio",
        "lidge-ai",
        "epyc-01",
        "headless-1",
        "headless-2",
        "cloud-sandbox",
        "raspberry-pi",
      ]),
    ),
  ).toEqual({
    "cloud-sandbox": "text-orange-500",
    "epyc-01": "text-amber-500",
    "headless-1": "text-emerald-500",
    "headless-2": "text-violet-500",
    "juns-mac-studio": "text-lime-600",
    "juns-macbook-pro": "text-rose-500",
    "lidge-ai": "text-pink-500",
    "raspberry-pi": "text-teal-500",
  });
});

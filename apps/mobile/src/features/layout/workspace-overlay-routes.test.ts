import { expect, it } from "vite-plus/test";
import { isNewTaskRoute } from "./workspace-overlay-routes";

it("recognizes every new task or project route and leaves existing threads alone", () => {
  expect(isNewTaskRoute({ name: "NewTaskProject" })).toBe(true);
  expect(isNewTaskRoute({ name: "NewTaskEnvironment" })).toBe(true);
  expect(isNewTaskRoute({ name: "AddProjectRepository" })).toBe(true);
  expect(isNewTaskRoute({ name: "Thread", params: { draft: { id: "new" } } })).toBe(true);
  expect(isNewTaskRoute({ name: "Thread" })).toBe(false);
  expect(isNewTaskRoute({ name: "Thread", params: { draft: null } })).toBe(false);
});

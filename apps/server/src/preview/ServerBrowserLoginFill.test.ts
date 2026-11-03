import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { fillLogin } from "./ServerBrowserLoginFill.ts";

type FieldKind = "text" | "email" | "password";

const makePage = (kinds: FieldKind[], pausePassword?: () => Promise<void>) => {
  const site = { origin: "https://login.test" };
  const doc: { activeElement?: Input; origin?: string } = {};
  class Input {
    disabled = false;
    hidden = false;
    parentElement = null;
    readOnly = false;
    isConnected = true;
    ownerDocument = doc;
    autocomplete = "";
    form: { elements: Input[] } | null = null;
    private current = "";
    readonly type: FieldKind;
    constructor(type: FieldKind) {
      this.type = type;
    }
    get value() {
      return this.current;
    }
    set value(value: string) {
      this.current = value;
    }
    getClientRects() {
      return [1];
    }
    dispatchEvent() {
      return true;
    }
    compareDocumentPosition(other: Input) {
      return this.form && this.form.elements.indexOf(this) < this.form.elements.indexOf(other)
        ? 4
        : 2;
    }
  }
  const fields = kinds.map((kind) => new Input(kind));
  const form = { elements: fields };
  for (const field of fields) field.form = form;
  doc.activeElement = fields[0]!;
  let object: unknown;
  let mutations = 0;
  const masked: string[] = [];
  const sent: string[] = [];
  const send = async (method: string, params: Record<string, unknown>) => {
    if (method === "Runtime.releaseObject") return {};
    const declaration = String(params.functionDeclaration);
    const args = (params.arguments ?? []) as Array<{ value: unknown }>;
    const fn = new Function(
      "document",
      "self",
      "HTMLInputElement",
      "Node",
      "Event",
      "getComputedStyle",
      `return (${declaration})`,
    )(doc, site, Input, { DOCUMENT_POSITION_FOLLOWING: 4 }, Event, (field: Input) => ({
      display: field.hidden ? "none" : "block",
      visibility: "visible",
      opacity: "1",
    })) as (...args: unknown[]) => unknown;
    if (declaration.includes("GOAT_LOGIN_MUTATE")) {
      if (args[0]?.value === "password") await pausePassword?.();
      mutations++;
      sent.push(String(args[0]?.value));
    }
    const result = fn.apply(
      params.objectId ? object : undefined,
      args.map((arg) => arg.value),
    );
    if (typeof result === "object" && result !== null) {
      object = result;
      return { result: { objectId: "login-fields", type: "object" } };
    }
    return { result: { value: result } };
  };
  return {
    fields,
    site,
    send,
    masked,
    sent,
    mutations: () => mutations,
    register: (value: string) => masked.push(value),
  };
};

it.live("fills one login in order and confirms both values without returning them", () =>
  Effect.promise(async () => {
    const page = makePage(["text", "password"]);
    const result = await fillLogin({
      send: page.send,
      contextId: 1,
      origin: "https://login.test",
      login: { username: "user-sentinel", password: "password-sentinel" },
      register: page.register,
    });
    expect(result).toEqual({ usernameFilled: true, passwordFilled: true, verdict: "confirmed" });
    expect(page.fields.map((field) => field.value)).toEqual(["user-sentinel", "password-sentinel"]);
    expect(page.sent).toEqual(["username", "password"]);
    expect(page.masked).toEqual(["user-sentinel", "password-sentinel"]);
    expect(JSON.stringify(result)).not.toContain("sentinel");
  }),
);

it.live("refuses missing or ambiguous fields before sending anything", () =>
  Effect.promise(async () => {
    for (const fields of [
      ["text"],
      ["text", "password", "password"],
      ["text", "email", "password"],
      ["password"],
    ] as FieldKind[][]) {
      const page = makePage(fields);
      const result = await fillLogin({
        send: page.send,
        contextId: 1,
        origin: "https://login.test",
        login: { username: "test-user", password: "test-password" },
        register: page.register,
      });
      expect(result).toMatchObject({
        usernameFilled: false,
        passwordFilled: false,
        verdict: "refused",
        code: expect.any(String),
      });
      expect(page.mutations()).toBe(0);
    }
  }),
);

it.effect("reports partial delivery when the origin changes before password dispatch", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = Promise.withResolvers<void>();
    const page = makePage(["text", "password"], async () => {
      Deferred.doneUnsafe(entered, Effect.void);
      await resume.promise;
    });
    yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.await(entered);
        page.site.origin = "https://other.test";
        resume.resolve();
      }),
    );
    const result = yield* Effect.promise(() =>
      fillLogin({
        send: page.send,
        contextId: 1,
        origin: "https://login.test",
        login: { username: "test-user", password: "test-password" },
        register: page.register,
      }),
    );
    expect(result).toMatchObject({
      usernameFilled: true,
      passwordFilled: false,
      verdict: "unverifiable",
    });
    expect(page.fields.map((field) => field.value)).toEqual(["test-user", ""]);
  }),
);

it.live("refuses a prefilled different account before either mutation", () =>
  Effect.promise(async () => {
    const page = makePage(["text", "password"]);
    page.fields[0]!.value = "different-account";
    const result = await fillLogin({
      send: page.send,
      contextId: 1,
      origin: "https://login.test",
      login: { username: "test-user", password: "test-password" },
      register: page.register,
    });
    expect(result).toMatchObject({
      usernameFilled: false,
      passwordFilled: false,
      verdict: "refused",
    });
    expect(page.fields.map((field) => field.value)).toEqual(["different-account", ""]);
  }),
);

it.live("returns unverifiable if a page changes a field before masked read-back", () =>
  Effect.promise(async () => {
    const page = makePage(["text", "password"]);
    const send = async (method: string, params: Record<string, unknown>) => {
      if (String(params.functionDeclaration).includes("u.value === username"))
        page.fields[0]!.value = "changed";
      return page.send(method, params);
    };
    const result = await fillLogin({
      send,
      contextId: 1,
      origin: "https://login.test",
      login: { username: "test-user", password: "test-password" },
      register: page.register,
    });
    expect(result).toEqual({ usernameFilled: true, passwordFilled: true, verdict: "unverifiable" });
  }),
);

it.live("ignores hidden password fields when finding a unique visible form", () =>
  Effect.promise(async () => {
    const page = makePage(["text", "password", "password"]);
    page.fields[2]!.hidden = true;
    const result = await fillLogin({
      send: page.send,
      contextId: 1,
      origin: "https://login.test",
      login: { username: "test-user", password: "test-password" },
      register: page.register,
    });
    expect(result).toEqual({ usernameFilled: true, passwordFilled: true, verdict: "confirmed" });
    expect(page.fields[2]!.value).toBe("");
  }),
);

it.live("prefers the named username and masks both values before any input", () =>
  Effect.promise(async () => {
    const page = makePage(["text", "email", "password"]);
    page.fields[1]!.autocomplete = "username";
    const send = async (method: string, params: Record<string, unknown>) => {
      if (String(params.functionDeclaration).includes("GOAT_LOGIN_MUTATE"))
        expect(page.masked).toEqual(["test-user", "test-password"]);
      return page.send(method, params);
    };
    const result = await fillLogin({
      send,
      contextId: 1,
      origin: "https://login.test",
      login: { username: "test-user", password: "test-password" },
      register: page.register,
    });
    expect(result.verdict).toBe("confirmed");
    expect(page.fields.map((field) => field.value)).toEqual(["", "test-user", "test-password"]);
  }),
);

it.effect("refuses the password if the form changes accounts after the username", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = Promise.withResolvers<void>();
    const page = makePage(["text", "password"], async () => {
      Deferred.doneUnsafe(entered, Effect.void);
      await resume.promise;
    });
    yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.await(entered);
        page.fields[0]!.value = "another-account";
        resume.resolve();
      }),
    );
    const result = yield* Effect.promise(() =>
      fillLogin({
        send: page.send,
        contextId: 1,
        origin: "https://login.test",
        login: { username: "test-user", password: "test-password" },
        register: page.register,
      }),
    );
    expect(result).toEqual({
      usernameFilled: true,
      passwordFilled: false,
      verdict: "unverifiable",
    });
    expect(page.fields[1]!.value).toBe("");
  }),
);

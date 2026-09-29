/** The local Tools tab runs a tool through the paired browser session, not the SDK bearer route. */
import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, mutation, query, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    echo: query({ input: object({ message: string() }) }, async (_, input) => {
      if (input.message === "fail") throw new Error("Synthetic tool failure");
      return { echoed: input.message };
    }),
    guarded: mutation({ input: object({}), approval: () => "user-approval" }, async () => "ran"),
  }),
}));`;

layer(TestLive, { excludeTestServices: true })("Local tool runner", (it) => {
  it.effect(scenarios.localToolRunner.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          browser = yield* Browser,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const response = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Tool runner ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          },
          headers,
        );
        expect(response.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          response,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(
          agent,
          `/v1/apps/${app.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("Local pairing completes before app navigation", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the tool in the Tools tab", (page) =>
          page.goto(`/apps/${app.id}?view=tools&profile=${profile.id}&tool=echo`),
        );
        yield* browser.use("The runner is ready", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).waitFor(),
        );
        yield* browser.use("The input starts with the required fields", (page) =>
          page.waitForFunction(
            () =>
              document.querySelector<HTMLTextAreaElement>("textarea")?.value ===
              JSON.stringify({ message: "" }, null, 2),
          ),
        );
        yield* browser.use("Run the tool", (page) =>
          page
            .getByLabel("Input", { exact: true })
            .fill(JSON.stringify({ message: "hello from local" }))
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        expect(
          yield* browser.use("The result is shown", (page) =>
            page
              .getByRole("region", { name: "Tool result", exact: true })
              .waitFor()
              .then(() =>
                page.getByRole("region", { name: "Tool result", exact: true }).textContent(),
              ),
          ),
        ).toContain("hello from local");
        yield* browser.checkpoint("Local tool result");
        const failing = JSON.stringify({ message: "fail" });
        yield* browser.use("Run a failing call", (page) =>
          page
            .getByLabel("Input", { exact: true })
            .fill(failing)
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        yield* browser.use("The failure is explained", (page) =>
          page.getByText("The tool failed", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The failed call keeps its input and drops the old result", (page) =>
            Promise.all([
              page.getByLabel("Input", { exact: true }).inputValue(),
              page.getByRole("region", { name: "Tool result", exact: true }).count(),
            ]),
          ),
        ).toEqual([failing, 0]);
        yield* browser.checkpoint("Local tool failure");
        yield* browser.use("Open a tool that needs approval", (page) =>
          page.getByRole("button", { name: "guarded", exact: true }).click(),
        );
        yield* browser.use("Run the tool that needs approval", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use("The dashboard does not bypass approval", (page) =>
          page.getByText("Approval required", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The approval-gated tool shows no result", (page) =>
            page.getByRole("region", { name: "Tool result", exact: true }).count(),
          ),
        ).toBe(0);
      }),
    ),
  );
});

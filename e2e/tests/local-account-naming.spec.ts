/** Local accounts are named after they connect, in a dialog over the page that follows. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import {
  accountNameField,
  accountNamePrompt,
  nameAccountDialog,
  nameConnectedAccount,
} from "../support/name-account.ts";
import { Target } from "../support/platform.ts";
import { oauthRecoveryIssuer } from "../support/oauth-recovery-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Account = Schema.Struct({ id: Schema.String, label: Schema.String });
const Detail = Schema.Struct({ account: Account });
const Published = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const prompt = "Local naming fixture is connected. Choose a name you’ll recognize.";

layer(TestLive, { excludeTestServices: true })("Local account naming", (it) => {
  it.effect(scenarios.localPastedCredentialsNamedAfterSaving.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        // The agent API takes the host-issued bearer credential, not a browser origin.
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Local naming ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = defineProvider({ name: "Local naming fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));
`,
              },
              appsManifest,
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Published, deployed);
        const provider = app.requirements.accounts.service.provider;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [`/v1/apps/${app.id}`, ...accounts.map((id) => `/v1/accounts/${id}`)],
            (path) =>
              session
                .send("DELETE", path, undefined, headers)
                .pipe(
                  Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
                ),
          ).pipe(Effect.orDie),
        );
        const savedLabel = (account: string) =>
          session.send("GET", `/dashboard/api/accounts/${account}`, undefined, headers).pipe(
            Effect.flatMap((response) => body(Detail, response)),
            Effect.map((detail) => detail.account.label),
          );
        const add = (label?: string) =>
          Effect.gen(function* () {
            const account = yield* body(
              Account,
              yield* session.send(
                "POST",
                "/dashboard/api/accounts",
                {
                  provider,
                  method: "key",
                  ...(label === undefined ? {} : { label }),
                  fields: { token: "synthetic-local-naming-token" },
                },
                headers,
              ),
            );
            accounts.push(account.id);
            return account.label;
          });
        expect(yield* add()).toBe("Default");
        expect(yield* add()).toBe("Default 2");
        expect(yield* add("Supplied name")).toBe("Supplied name");

        // Account selection connects into an existing profile, as it does once an app is in use.
        yield* createProfile(
          agent,
          `/v1/apps/${app.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );

        yield* browser.use("Open Add account for the provider", (page) =>
          page.goto(`/accounts/add?provider=${encodeURIComponent(provider)}`),
        );
        expect(
          yield* browser.use("The credential form does not ask for a name", (page) =>
            page
              .getByLabel("Token", { exact: true })
              .waitFor({ state: "visible" })
              .then(() => page.getByRole("textbox", { name: "Account name" }).count()),
          ),
        ).toBe(0);
        yield* browser.use("Enter the synthetic API key", (page) =>
          page.getByLabel("Token", { exact: true }).fill("synthetic-local-naming-token"),
        );
        const submitted = yield* browser.use("Add the account", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/dashboard/api/accounts",
            ),
            page.getByRole("button", { name: "Add account", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        const created = yield* Schema.decodeUnknownEffect(Account)(submitted);
        accounts.push(created.id);
        expect(created.label).toBe("Default 3");
        // Add account returns to Accounts; the prompt belongs to the dashboard and survives it.
        const added = yield* browser.use("Accounts asks for a name after Add account", (page) =>
          page
            .waitForURL((url) => url.pathname === "/accounts")
            .then(() => accountNamePrompt(page))
            .then(() =>
              nameAccountDialog(page)
                .getByText(prompt, { exact: true })
                .waitFor({ state: "visible" }),
            )
            .then(() => accountNameField(page).inputValue())
            .then((name) => ({ name, path: new URL(page.url()).pathname })),
        );
        expect(added).toEqual({ name: "Default 3", path: "/accounts" });
        yield* browser.checkpoint("Name the added account over Accounts");
        yield* browser.use("Save a recognizable name", (page) =>
          nameConnectedAccount(page, "Personal key"),
        );
        yield* browser.use("Accounts lists the new name", (page) =>
          page.getByRole("button", { name: "Manage Personal key", exact: true }).waitFor(),
        );
        expect(yield* savedLabel(created.id)).toBe("Personal key");
        yield* browser.checkpoint("Named account in the account list");

        yield* browser.use("Update the named account's credentials", (page) =>
          page.goto(`/accounts/${created.id}/credentials`),
        );
        yield* browser.use("Enter a replacement API key", (page) =>
          page.getByLabel("Token", { exact: true }).fill("synthetic-local-naming-token-2"),
        );
        yield* browser.use("Save the replacement credentials", (page) =>
          page.getByRole("button", { name: "Save credentials", exact: true }).click(),
        );
        // A naming step would hold the page until it was answered.
        yield* browser.use("Replacing credentials returns to the account", (page) =>
          page.waitForURL(
            (url) => url.pathname === "/accounts" && url.searchParams.get("account") === created.id,
          ),
        );
        yield* browser.use("The account keeps its name", (page) =>
          page.getByRole("button", { name: "Manage Personal key", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Replacing credentials does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        expect(yield* savedLabel(created.id)).toBe("Personal key");

        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account from the app's accounts", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", {
            name: "Connect Local naming fixture",
            exact: true,
          });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* browser.use("Enter the dialog's API key", () =>
          connect.getByLabel("Token", { exact: true }).fill("synthetic-local-naming-token"),
        );
        const dialogSubmitted = yield* browser.use("Add the account from the dialog", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/dashboard/api/accounts",
            ),
            connect.getByRole("button", { name: "Add account", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        const fromDialog = yield* Schema.decodeUnknownEffect(Account)(dialogSubmitted);
        accounts.push(fromDialog.id);
        // "Default 3" was renamed, so it is free again.
        expect(fromDialog.label).toBe("Default 3");
        yield* browser.use("The connection dialog closes and asks for a name", (page) =>
          connect
            .waitFor({ state: "hidden" })
            .then(() => accountNamePrompt(page))
            .then(() =>
              nameAccountDialog(page)
                .getByText(prompt, { exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        expect(
          yield* browser.use("The dialog's name starts as the saved default", (page) =>
            accountNameField(page).inputValue(),
          ),
        ).toBe("Default 3");
        yield* browser.checkpoint("Name the account over the app's accounts");
        yield* browser.use("Save the dialog account's name", (page) =>
          nameConnectedAccount(page, "Dialog key"),
        );
        // Saving a new account from the app chooses it in place.
        yield* browser.use("The app chooses the renamed account", (page) =>
          page.getByRole("radio", { name: "Dialog key", exact: true, checked: true }).waitFor(),
        );
        expect(yield* savedLabel(fromDialog.id)).toBe("Dialog key");
        yield* browser.checkpoint("Named account selected for the app");
      }),
    ),
  );

  it.effect(scenarios.localOAuthNamedAfterReturn.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const api = yield* Api;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin, true, "redirect");
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Local OAuth naming ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin)},scopes:["reports:read"]})}});
export default defineApp({accounts:{service}},async()=>({tools:router({})}));`,
              },
              appsManifest,
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Published, deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [`/v1/apps/${app.id}`, ...accounts.map((id) => `/v1/accounts/${id}`)],
            (path) => session.send("DELETE", path, undefined, headers),
          ).pipe(Effect.orDie),
        );
        const savedLabel = (account: string) =>
          session.send("GET", `/dashboard/api/accounts/${account}`, undefined, headers).pipe(
            Effect.flatMap((response) => body(Detail, response)),
            Effect.map((detail) => detail.account.label),
          );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        // Client navigation: a direct load of an OAuth credential form renders "Action unavailable".
        yield* browser.use("Open Add account for the OAuth provider", (page) =>
          page
            .goto("/accounts")
            .then(() =>
              page.getByRole("link", { name: "Add account", exact: true }).first().click(),
            )
            .then(() => page.getByRole("button", { name: /Sample service/ }).click()),
        );
        yield* browser.use("Start sign-in without naming the account", (page) =>
          page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
        );
        yield* browser.use("Allow access", (page) =>
          page.getByRole("button", { name: "Allow access", exact: true }).click(),
        );
        const returned = yield* browser.use("Return to the account to name it", (page) =>
          page
            .waitForURL((url) => url.pathname === "/accounts" && url.searchParams.has("account"))
            .then(() => accountNamePrompt(page))
            .then(() =>
              nameAccountDialog(page)
                .getByText("Sample service is connected. Choose a name you’ll recognize.", {
                  exact: true,
                })
                .waitFor({ state: "visible" }),
            )
            .then(() => accountNameField(page).inputValue())
            .then((name) => ({ name, url: new URL(page.url()) })),
        );
        const account = returned.url.searchParams.get("account") ?? "";
        accounts.push(account);
        expect(returned.name).toBe("Default");
        expect([...returned.url.searchParams.keys()]).toEqual(["account"]);
        yield* browser.checkpoint("Name a local OAuth account after sign-in returns");
        yield* browser.use("Name the OAuth account", (page) =>
          nameConnectedAccount(page, "Local reports"),
        );
        yield* browser.use("The account list shows the saved name", (page) =>
          page.getByRole("button", { name: "Manage Local reports", exact: true }).waitFor(),
        );
        expect(yield* savedLabel(account)).toBe("Local reports");

        // Client navigation: a direct load of an OAuth credential form renders "Action unavailable".
        yield* browser.use("Reconnect the named account", (page) =>
          page
            .getByRole("button", { name: "Manage Local reports", exact: true })
            .click()
            .then(() =>
              page.getByRole("menuitem", { name: "Update credentials", exact: true }).click(),
            )
            .then(() =>
              page.getByRole("button", { name: "Reconnect Sample service", exact: true }).click(),
            ),
        );
        yield* browser.use("Allow access again", (page) =>
          page.getByRole("button", { name: "Allow access", exact: true }).click(),
        );
        yield* browser.use("A reconnect returns to its account", (page) =>
          page
            .waitForURL(
              (url) => url.pathname === "/accounts" && url.searchParams.get("account") === account,
            )
            .then(() =>
              page.getByRole("button", { name: "Manage Local reports", exact: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("A reconnect does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        expect(yield* savedLabel(account)).toBe("Local reports");
        expect((yield* issuer.observations).filter((entry) => entry.tokenAccepted)).toHaveLength(2);
        yield* browser.checkpoint("Reconnected local OAuth account keeps its name");
      }),
    ),
  );
});

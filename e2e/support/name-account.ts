/**
 * New accounts are named after they connect. The dashboard layout shows one "Name this account"
 * dialog over whatever page follows a new connection, on hosted and local alike. It is modal, so a
 * journey that connects a new account in the UI must answer or dismiss it before continuing.
 */
import type { Page } from "playwright";

export const nameAccountDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Name this account", exact: true });

/** The dialog's name field, prefilled with the name the server saved. */
export const accountNameField = (page: Page) =>
  nameAccountDialog(page).getByRole("textbox", { name: "Account name", exact: true });

/** Wait until the prompt has loaded the connected account and offers its saved name. */
export const accountNamePrompt = (page: Page) =>
  accountNameField(page).waitFor({ state: "visible" });

/**
 * Wait for the prompt, optionally replace the server's default name, save it and wait for the
 * dialog to close. Saving an unchanged name keeps the default.
 */
export const nameConnectedAccount = (page: Page, label?: string) =>
  accountNamePrompt(page)
    .then(() => (label === undefined ? undefined : accountNameField(page).fill(label)))
    .then(() =>
      nameAccountDialog(page).getByRole("button", { name: "Save name", exact: true }).click(),
    )
    .then(() => nameAccountDialog(page).waitFor({ state: "hidden" }));

/** Wait for the prompt, close it with Escape and keep the default name. */
export const dismissAccountName = (page: Page) =>
  accountNamePrompt(page)
    .then(() => page.keyboard.press("Escape"))
    .then(() => nameAccountDialog(page).waitFor({ state: "hidden" }));

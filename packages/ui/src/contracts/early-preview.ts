/** Copy shared by the marketing and cloud dashboard beta notices. */
export const earlyPreview = {
  title: "An early look at Executor v2",
  migration: {
    title: "Where is my v1 data?",
    description:
      "We expect to migrate your v1 data in about a week. This is an early build of Executor v2. Try the new version, share feedback, and help us squash bugs.",
  },
  paragraphs: ["Sit back enjoy v1 and you'll be cleanly migrated over soon"],
} as const;

/**
 * Cookie that keeps the beta notice dismissed across the site and product pages. The dashboard
 * server reads it, so a dismissed notice is never rendered.
 */
export const betaNoticeDismissalCookie = "executor-beta-notice";

/** The `document.cookie` assignment that records a dismissal for a year. */
export const betaNoticeDismissal = (secure: boolean) =>
  `${betaNoticeDismissalCookie}=dismissed; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;

/** Whether a `Cookie` header or `document.cookie` value records a dismissal. */
export const betaNoticeDismissed = (cookies: string) =>
  cookies.split(/;\s*/).includes(`${betaNoticeDismissalCookie}=dismissed`);

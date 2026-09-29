import { defineApp, router } from "apps";
import { requirements } from "./context.ts";
import { findMail } from "./tools.ts";
import { issueOpened } from "./webhooks.ts";

export default defineApp(requirements, {
  tools: router({ findMail }),
  webhooks: { issueOpened },
});

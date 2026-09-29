/** Start's document handler. The product server calls it in-process for dashboard pages. */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

export default { fetch: createStartHandler(defaultStreamHandler) };

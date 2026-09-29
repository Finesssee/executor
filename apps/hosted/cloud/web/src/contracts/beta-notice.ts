/** Whether this browser dismissed the beta notice; the server reads it from the dismissal cookie. */
import { Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

export const betaNoticeDismissedAtom = Atom.make(false).pipe(
  Atom.serializable({ key: "cloud:beta-notice-dismissed", schema: Schema.Boolean }),
  Atom.keepAlive,
);

/** Failure detail that crosses the runtime boundary to the app's own caller. */
import { Schema } from "effect";

/** Longest failure message carried across the runtime boundary. */
export const maxFailureMessageLength = 2048;
/**
 * `app` for errors thrown by authored code, `storage` for app data failures the host raised, and
 * `service` for an external API the app called through a framework helper.
 */
export const FailureSource = Schema.Literals(["app", "storage", "service"]);
/** The thrown error's name, such as `TypeError`, or the host error's tag. */
export const FailureName = Schema.String.check(Schema.isMaxLength(128));
/** A stable host failure code, such as an app data reason. */
export const FailureCode = Schema.String.check(Schema.isMaxLength(128));
/** Bounded, with the invocation's account secrets replaced. */
export const FailureMessage = Schema.String.check(Schema.isMaxLength(maxFailureMessageLength));
/**
 * The error an app's own code raised, or the specific host failure it hit. Stacks and cause
 * values stay private. Builds from before these fields existed send none.
 */
export const FailureDetail = {
  source: Schema.optionalKey(FailureSource),
  errorName: Schema.optionalKey(FailureName),
  code: Schema.optionalKey(FailureCode),
  message: Schema.optionalKey(FailureMessage),
};

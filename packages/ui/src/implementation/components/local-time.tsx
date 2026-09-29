/** A moment shown in the reader's local time, safe to render on the server. */
import { formatMoment, useDisplayFormat } from "../hooks/display-format.ts";

/**
 * Engines format the same moment differently, and the server may not know the reader's time
 * zone, so the browser keeps the server's text through hydration and replaces it right after.
 */
export function LocalTime({
  value,
  options,
  title,
}: {
  readonly value: Date | number | string;
  readonly options?: Intl.DateTimeFormatOptions;
  readonly title?: Intl.DateTimeFormatOptions;
}) {
  const format = useDisplayFormat();
  const moment = new Date(value);
  return (
    <time
      dateTime={moment.toISOString()}
      suppressHydrationWarning
      {...(title === undefined ? {} : { title: formatMoment(moment, format, title) })}
    >
      {formatMoment(moment, format, options)}
    </time>
  );
}

/** Time of day only. */
export const timeOfDay: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};
/** Short month, day and time, for metadata rows. */
export const shortMoment: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

import type { AccountAppHealth, AccountHealth } from "@executor-js/sdk";
import { Exit, Match, type Cause } from "effect";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { AccountDetail, FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { LocalTime, shortMoment } from "../components/local-time.tsx";
import { formatMoment, useDisplayFormat } from "../hooks/display-format.ts";

type Check = NonNullable<AccountAppHealth["check"]>;
type AccountInfo = NonNullable<AccountHealth["info"]>;

/** What one app's latest check means for the reader; tone matches the other status pills. */
const describe = (check: Check) =>
  Match.value(check.status).pipe(
    Match.when("healthy", () => ({ label: "Working", tone: "good" as const })),
    Match.when("credentials_rejected", () => ({
      label: "Sign-in rejected",
      tone: "bad" as const,
    })),
    Match.when("forbidden", () => ({ label: "Missing permission", tone: "warn" as const })),
    Match.when("upstream_unavailable", () => ({
      label: "Service unavailable",
      tone: "warn" as const,
    })),
    Match.when("check_failed", () => ({ label: "Check failed", tone: "muted" as const })),
    Match.exhaustive,
  );

const tones = {
  good: "bg-emerald-500",
  bad: "bg-destructive",
  warn: "bg-amber-500",
  muted: "bg-muted-foreground/50",
};

/**
 * One app's latest check as a dot on its app reference. A result from before the account's
 * credentials or the app changed is shown as outdated, never as the current state. Apps without a
 * check, or not yet checked, show nothing.
 */
export function AccountCheckDot({ health }: { readonly health: AccountAppHealth | undefined }) {
  const format = useDisplayFormat();
  const check = health?.check;
  if (check === null || check === undefined) return null;
  const { label, tone } = describe(check);
  const text = check.current ? label : `${label} (outdated)`;
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${check.current ? tones[tone] : tones.muted}`}
      data-check-status={check.status}
      data-check-current={check.current}
      role="img"
      aria-label={text}
      title={`${text} · ${formatMoment(new Date(check.checkedAt), format, shortMoment)}`}
      suppressHydrationWarning
    />
  );
}

/** The upstream identity a check reported, for the account heading. */
export function AccountIdentity({
  info,
  avatar = false,
}: {
  readonly info: AccountInfo;
  /** Only client-rendered views show the avatar, so a failed load can remove it. */
  readonly avatar?: boolean;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const name = info.displayName ?? info.username ?? info.email;
  const secondary = [
    info.username !== undefined && info.username !== name ? `@${info.username}` : undefined,
    info.email !== undefined && info.email !== name ? info.email : undefined,
  ].filter((part) => part !== undefined);
  if (name === undefined) return null;
  return (
    <span className="account-identity inline-flex items-center gap-1.5 min-w-0">
      {avatar && info.avatarUrl !== undefined && !avatarFailed && (
        <img
          onError={() => setAvatarFailed(true)}
          src={info.avatarUrl}
          alt=""
          className="size-4 shrink-0 rounded-full"
          referrerPolicy="no-referrer"
        />
      )}
      <span className="wrap-anywhere">
        {info.profileUrl === undefined ? (
          name
        ) : (
          <a
            className="hover:text-foreground"
            href={info.profileUrl}
            target="_blank"
            rel="noreferrer"
          >
            {name}
          </a>
        )}
        {secondary.length > 0 && ` · ${secondary.join(" · ")}`}
      </span>
    </span>
  );
}

/**
 * Each selecting app's latest check, with an action to check again. Opening it checks once when a
 * result is missing or outdated, such as after new credentials.
 */
export function AccountHealthPanel<E>({
  data,
  check,
  Failure,
  actions,
}: {
  readonly data: AccountDetail;
  readonly check: () => Promise<Exit.Exit<AccountHealth, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly actions?: ReactNode;
}) {
  const { apps, health } = data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const checkable = health?.apps.some((entry) => entry.checkable) ?? false;
  const stale =
    health?.apps.some(
      (entry) => entry.checkable && (entry.check === null || !entry.check.current),
    ) ?? false;
  const run = async () => {
    setPending(true);
    setError(undefined);
    const exit = await check();
    setPending(false);
    if (Exit.isFailure(exit)) setError(exit.cause);
  };
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !stale) return;
    opened.current = true;
    void run();
  });
  return (
    <div className="flex flex-col gap-4">
      {health?.info && (
        <p className="text-[13px] text-muted-foreground">
          <AccountIdentity info={health.info} avatar />
        </p>
      )}
      {apps.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No apps use this account, so nothing checks it.
        </p>
      ) : (
        <ul className="flex flex-col text-[13px] [&_>_li+li]:border-t [&_>_li+li]:border-t-border">
          {apps.map((app) => {
            const entry = health?.apps.find((item) => item.app === app.id);
            return (
              <li key={app.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 wrap-anywhere">{app.name}</span>
                <AccountCheckResult health={entry} />
              </li>
            );
          })}
        </ul>
      )}
      {error && <Failure cause={error} />}
      <div className="flex items-center gap-3">
        <Button
          loading={pending}
          disabledReason={checkable ? undefined : "No app that uses this account defines a check."}
          onClick={() => {
            if (!pending) void run();
          }}
        >
          Check now
        </Button>
        {actions}
      </div>
    </div>
  );
}

/** One app's latest check, spelled out with its time. */
export function AccountCheckResult({ health }: { readonly health: AccountAppHealth | undefined }) {
  if (health === undefined || (!health.checkable && health.check === null))
    return <span className="text-[12px] text-muted-foreground">No check</span>;
  if (health.check === null)
    return <span className="text-[12px] text-muted-foreground">Not checked</span>;
  const { label, tone } = describe(health.check);
  return (
    <span className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
      <span
        className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${health.check.current ? pills[tone] : pills.muted}`}
        data-check-status={health.check.status}
        data-check-current={health.check.current}
      >
        {health.check.current ? label : `${label} · outdated`}
      </span>
      <LocalTime value={health.check.checkedAt} options={shortMoment} />
    </span>
  );
}

const pills = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  muted: "bg-muted text-muted-foreground",
};

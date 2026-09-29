import { useState, type ComponentType, type ReactNode } from "react";
import { Exit, Match, Option, Redacted, type Cause } from "effect";
import type { Account, CredentialCheck, Provider } from "@executor-js/sdk";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { FailureProps } from "../../contracts/dashboard.ts";
import {
  accountFields,
  credentialsComplete,
  credentialValues,
  type AccountSubmission,
  type AccountOAuthProps,
} from "../../contracts/credentials.ts";
import { CredentialFields } from "../components/credential-fields.tsx";
import { Button } from "../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

/** One credential form for creation, reconnection and agent handoff; the host owns saving, naming and navigation. */
export function AccountForm<A, E>({
  provider,
  account,
  header,
  actions,
  submitLabel,
  submit,
  onSaved,
  oauth,
  Failure,
  onPendingChange,
  initialMethod,
  check,
  disabled = false,
}: {
  /**
   * Check complete credentials before saving, with the app that will use them. The form shows
   * whether they work; saving stays the user's choice. Null means the app defines no check.
   */
  readonly check?: (input: AccountSubmission) => Promise<Exit.Exit<CredentialCheck | null, E>>;
  readonly provider: Provider;
  readonly account?: Pick<Account, "method">;
  readonly header?: ReactNode;
  readonly actions?: ReactNode;
  readonly submitLabel: string;
  readonly submit: (input: AccountSubmission) => Promise<Exit.Exit<A, E>>;
  readonly onSaved: (value: NoInfer<A>) => void;
  readonly oauth: (props: AccountOAuthProps) => ReactNode;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly disabled?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly initialMethod?: string | undefined;
}) {
  const methods = Object.entries(provider.definition.auth).sort(
    ([, a], [, b]) => Number(b.type === "oauth2") - Number(a.type === "oauth2"),
  );
  const [method, setMethod] = useState(account?.method ?? initialMethod ?? methods[0]?.[0] ?? "");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setPending] = useState(false);
  const pending = submitting || disabled;
  const [error, setError] = useState<Cause.Cause<E>>();
  const auth = provider.definition.auth[method];
  const parsed = auth && accountFields(auth);
  const fields = parsed && Option.isSome(parsed) ? parsed.value : undefined;
  const updatePending = (value: boolean) => {
    setPending(value);
    onPendingChange?.(value);
  };
  const [verdict, setVerdict] = useState<Verdict>({ state: "idle" });
  // Only secrets can be validated before saving; OAuth has its own sign-in.
  const validates = check !== undefined && auth?.type === "secrets";
  const changeValues = (nextValues: Readonly<Record<string, string>>) => {
    setValues(nextValues);
    // A result belongs to the credentials it checked; any edit needs a new validation.
    setVerdict({ state: "idle" });
  };
  const save = (input: AccountSubmission) => {
    updatePending(true);
    setError(undefined);
    void submit(input).then((exit) => {
      updatePending(false);
      if (Exit.isFailure(exit)) setError(exit.cause);
      else {
        changeValues({});
        onSaved(exit.value);
      }
    });
  };
  return (
    <form
      className="setup-form flex max-w-145 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !fields ||
          pending ||
          verdict.state === "checking" ||
          !credentialsComplete(fields, values)
        )
          return;
        const input = { method, fields: Redacted.make(credentialValues(fields, values)) };
        if (!validates || check === undefined || verdict.state !== "idle") return save(input);
        setVerdict({ state: "checking" });
        void check(input).then((exit) => {
          // An app without a check has nothing to validate, so saving continues.
          if (Exit.isSuccess(exit) && exit.value === null) {
            setVerdict({ state: "idle" });
            save(input);
          } else
            setVerdict(
              Exit.isSuccess(exit) && exit.value !== null
                ? { state: "done", result: exit.value }
                : { state: "unverified" },
            );
        });
      }}
    >
      {header}
      {!account && methods.length > 1 && (
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Sign-in method
          <Select
            value={method}
            disabled={pending}
            onValueChange={(value) => {
              setMethod(value);
              changeValues({});
              setError(undefined);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {methods.map(([name, auth]) => (
                <SelectItem key={name} value={name}>
                  {auth.type === "oauth2" ? `Sign in with ${provider.definition.name}` : auth.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      {auth?.type === "oauth2" ? (
        <div key={method} className="oauth-fields flex flex-col gap-4">
          {oauth({ method, disabled, onPendingChange: updatePending })}
        </div>
      ) : fields ? (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {Object.keys(fields.properties).length === 0
              ? "This connection sends no credentials. Continue only if the service supports public access."
              : `Get these credentials from your ${provider.definition.name} account settings.`}
          </p>
          <CredentialFields
            fields={fields}
            values={values}
            onChange={changeValues}
            pending={pending}
          />
          {validates && auth?.type === "secrets" && (
            <CredentialVerdict
              verdict={verdict}
              label={auth.label}
              provider={provider.definition.name}
            />
          )}
          {error && <Failure cause={error} />}
          <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px] max-[480px]:[&_>_button]:basis-full">
            <Button
              type="submit"
              className="w-full"
              loading={pending || verdict.state === "checking"}
              disabled={!credentialsComplete(fields, values)}
            >
              {!validates || auth?.type !== "secrets"
                ? submitLabel
                : verdict.state === "checking"
                  ? "Validating…"
                  : verdict.state === "idle"
                    ? `Validate ${auth.label}`
                    : verdict.state === "done" && verdict.result.status === "healthy"
                      ? "Continue"
                      : "Continue anyway"}
            </Button>
            {actions}
          </div>
        </>
      ) : (
        <p className="setup-notice py-[12px] px-[14px] border border-border rounded-[7px] text-muted-foreground bg-muted text-[13px] my-[8px] mx-0">
          This provider needs a custom credential form.
        </p>
      )}
    </form>
  );
}

type Verdict =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "done"; readonly result: CredentialCheck }
  | { readonly state: "unverified" };

/**
 * Whether the entered credentials work, as the app's check found. The line keeps its height while
 * empty, so a result never moves the form.
 */
function CredentialVerdict({
  verdict,
  label,
  provider,
}: {
  readonly verdict: Verdict;
  readonly label: string;
  readonly provider: string;
}) {
  const shown =
    verdict.state === "done"
      ? verdict.result
      : verdict.state === "unverified"
        ? ({ status: "check_failed", info: null } as const)
        : undefined;
  const name = shown?.info?.displayName ?? shown?.info?.username ?? shown?.info?.email;
  const [tone, message] =
    shown === undefined
      ? (["muted", null] as const)
      : Match.value(shown.status).pipe(
          Match.when(
            "healthy",
            () =>
              [
                "good",
                name === undefined ? (
                  <>Valid {label}</>
                ) : (
                  <>
                    Signed in as <span className="font-medium text-foreground">{name}</span>
                  </>
                ),
              ] as const,
          ),
          Match.when(
            "credentials_rejected",
            () =>
              [
                "bad",
                <>
                  {provider} rejected this {label}
                </>,
              ] as const,
          ),
          Match.when(
            "forbidden",
            () => ["warn", <>This {label} is missing a permission the app needs</>] as const,
          ),
          Match.when(
            "upstream_unavailable",
            () => ["warn", <>Couldn't reach {provider} to check it</>] as const,
          ),
          Match.when("check_failed", () => ["warn", <>Couldn't verify this {label}</>] as const),
          Match.exhaustive,
        );
  return (
    <p
      className={`-mt-1 flex h-4 items-center gap-1.5 text-xs transition-opacity duration-150 ${
        shown === undefined ? "opacity-0" : "opacity-100"
      } ${tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}
      role="status"
      aria-live="polite"
      {...(shown === undefined ? {} : { "data-credential-check": shown.status })}
    >
      {message !== null && (
        <>
          <HugeiconsIcon
            icon={tone === "good" ? CheckmarkCircle02Icon : AlertCircleIcon}
            size={13}
            strokeWidth={2}
            className={
              tone === "good"
                ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                : tone === "bad"
                  ? "shrink-0"
                  : "shrink-0 text-amber-600 dark:text-amber-400"
            }
            aria-hidden
          />
          <span className="truncate">{message}</span>
        </>
      )}
    </p>
  );
}

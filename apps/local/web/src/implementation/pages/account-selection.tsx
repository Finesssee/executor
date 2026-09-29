import { useEffect, useRef } from "react";
import { Exit } from "effect";
import { QueryView } from "@executor-js/ui/dashboard/context";
import type { App, AppId, Profile, ProfileId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { appAtom } from "../../contracts/api.ts";
import { profilesAtom } from "../../contracts/profiles.ts";
import type { SetupSearch } from "../../contracts/navigation.ts";
import { useNavigate } from "@tanstack/react-router";
import { Failure, LoadingRows } from "../components/common.tsx";
import { AppDetailPage } from "./app-detail.tsx";
import { useAccountChooser } from "./app-accounts.tsx";

/** Setup links land on the Accounts tab; a newly connected account is bound to its slot first. */
export function AccountSelectionPage({
  id,
  data,
  ...search
}: { readonly id: AppId; readonly data: DashboardOverview } & SetupSearch) {
  const navigate = useNavigate();
  const open = (profile: ProfileId | undefined) =>
    void navigate({
      to: "/apps/$appId",
      params: { appId: id },
      search: { view: "accounts", profile },
      replace: true,
    });
  if (search.selected === undefined || search.slot === undefined)
    return <Redirect onMount={() => open(search.profile)} />;
  const { selected, slot } = search;
  return (
    <>
      <AppDetailPage
        id={id}
        overview={data}
        tab="accounts"
        tool={undefined}
        profile={search.profile}
      />
      <QueryView query={appAtom(id)} Failure={Failure} pending={<LoadingRows />}>
        {(snapshot) => (
          <QueryView query={profilesAtom({ app: id })} Failure={Failure} pending={<LoadingRows />}>
            {(profiles) => (
              <BindReturnedAccount
                app={snapshot.app}
                profile={profiles.find((item) => item.id === search.profile)}
                selected={selected}
                slot={slot}
                onDone={open}
              />
            )}
          </QueryView>
        )}
      </QueryView>
    </>
  );
}

function Redirect({ onMount }: { readonly onMount: () => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    onMount();
  });
  return null;
}

/** Add the account to a multi-account slot or replace a single-account slot, once. */
function BindReturnedAccount({
  app,
  profile,
  selected,
  slot,
  onDone,
}: {
  readonly app: App;
  readonly profile: Profile | undefined;
  readonly selected: NonNullable<SetupSearch["selected"]>;
  readonly slot: string;
  readonly onDone: (profile: ProfileId | undefined) => void;
}) {
  const chooser = useAccountChooser({ app, profile, onSelected: () => {} });
  const requirement = app.requirements.accounts[slot];
  const current = profile?.accounts[slot];
  return (
    <>
      <Redirect
        onMount={() => {
          if (requirement === undefined) return onDone(profile?.id);
          void chooser
            .choose(
              slot,
              requirement.cardinality === "many"
                ? [...new Set([...(Array.isArray(current) ? current : []), selected])]
                : selected,
            )
            .then((exit) => {
              // A failed bind stays here so its error is visible.
              if (Exit.isSuccess(exit)) onDone(exit.value.id);
            });
        }}
      />
      {chooser.error && <Failure cause={chooser.error} />}
    </>
  );
}

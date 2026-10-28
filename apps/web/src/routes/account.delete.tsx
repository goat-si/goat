import { SignIn, useUser } from "@clerk/react";
import { createFileRoute } from "@tanstack/react-router";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { AccountDeletionSection } from "../components/cloud/AccountDeletionSection";

export const Route = createFileRoute("/account/delete")({ component: AccountDeletionRoute });
function AccountDeletionRoute() {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold">Delete GOAT Connect account</h1>
      {hasCloudPublicConfig() ? (
        <SignedInDeletion />
      ) : (
        <p>GOAT Connect is unavailable in this build.</p>
      )}
    </main>
  );
}
function SignedInDeletion() {
  const { user } = useUser();
  return user ? (
    <AccountDeletionSection />
  ) : (
    <SignIn routing="hash" forceRedirectUrl="/account/delete" />
  );
}

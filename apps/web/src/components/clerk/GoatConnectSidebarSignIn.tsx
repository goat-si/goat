import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "~/components/solar";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { GOAT_CONNECT_ACCOUNT_PAGES } from "./GoatConnectAccountPages";
import { useGoatConnectAuthPrompt } from "./useGoatConnectAuthPrompt";

export function GoatConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredGoatConnectSidebarSignIn />;
}

export function GoatConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredGoatConnectSidebarAvatar />;
}

function ConfiguredGoatConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {GOAT_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredGoatConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useGoatConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to GOAT Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}

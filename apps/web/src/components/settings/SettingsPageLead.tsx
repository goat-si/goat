import { Link, useLocation } from "@tanstack/react-router";
import { Fragment } from "react";

import { SETTINGS_PAGE_LEADS } from "./settingsNav";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

function settingsPath(pathname: string): SettingsPath | null {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized in SETTINGS_SECTION_LABELS ? (normalized as SettingsPath) : null;
}

/** Names the page for assistive tech and says in one line what it holds. */
export function SettingsPageLead() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const path = settingsPath(pathname);
  if (path === null) return null;
  const lead = SETTINGS_PAGE_LEADS[path];
  return (
    <>
      <h1 className="sr-only">{SETTINGS_SECTION_LABELS[path]}</h1>
      {lead ? (
        <p className="max-w-[80ch] px-3 text-sm text-pretty text-muted-foreground sm:px-4">
          {lead.text}
          {lead.related?.length ? (
            <>
              {" "}
              <span className="whitespace-nowrap">See also:</span>{" "}
              {lead.related.map((link, index) => (
                <Fragment key={link.label}>
                  {index > 0 ? " · " : null}
                  <Link
                    to={link.to}
                    {...(link.hash ? { hash: link.hash } : {})}
                    hashScrollIntoView={false}
                    className="text-foreground/80 underline underline-offset-2 hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {link.label}
                  </Link>
                </Fragment>
              ))}
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

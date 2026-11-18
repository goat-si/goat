import {
  Button,
  Column,
  getMaterialColors,
  LinearProgressIndicator,
  Row,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  fillMaxSize,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
  width,
} from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

export function SubscriptionUsage(props: SubscriptionUsageProps, environment: WidgetEnvironment) {
  "widget";
  // The widget runtime evaluates this function without the app's module scope.
  const now = Date.now();
  const mode = props.theme?.mode;
  const appearance =
    mode === "light" || mode === "dark"
      ? mode
      : environment.colorScheme === "dark"
        ? "dark"
        : "light";
  const palette = props.theme?.[appearance];
  const colors = palette
    ? {
        surface: palette.background,
        onSurface: palette.foreground,
        onSurfaceVariant: palette.secondary,
        surfaceVariant: palette.track,
        primary: palette.accent,
        error: palette.danger,
      }
    : getMaterialColors({ scheme: appearance });
  const muted = colors.onSurfaceVariant;
  const providers = props.providers ?? [
    { name: "Codex", detail: "Open GOAT to connect", windows: [], expiresAt: 0, totalWindows: 0 },
    { name: "Claude", detail: "Open GOAT to connect", windows: [], expiresAt: 0, totalWindows: 0 },
  ];

  type Window = SubscriptionUsageProps["providers"][number]["windows"][number];
  type Line =
    | { provider: string; position: number; window: Window; detail?: never }
    | { provider: string; position: number; detail: string; window?: never };
  let omitted = 0;
  const order: Record<string, number> = { session: 0, weekly: 1 };
  const lines = providers
    .flatMap((provider): Line[] => {
      const stale =
        provider.windows.length > 0 && provider.expiresAt > 0 && now >= provider.expiresAt;
      if (stale || provider.windows.length === 0) {
        return [
          {
            provider: provider.name,
            position: 0,
            detail: stale ? "Expired · Open GOAT to refresh" : provider.detail,
          },
        ];
      }
      omitted += Math.max(0, (provider.totalWindows ?? 0) - provider.windows.length);
      return [...provider.windows]
        .sort((a, b) => (order[a.kind ?? ""] ?? 2) - (order[b.kind ?? ""] ?? 2))
        .map((window, position) => ({ provider: provider.name, position, window }));
    })
    .sort((a, b) => a.position - b.position);

  const inset = 16;
  const footerHeight = 16;
  const contentHeight = Math.max(0, (environment.height ?? 180) - inset * 2 - footerHeight);
  const contentWidth = Math.max(0, (environment.width ?? 250) - inset * 2);
  const fullHeight = 48;
  const overflowHeight = 14;
  const full =
    lines.length <= 9 &&
    lines.length * fullHeight + (omitted > 0 ? overflowHeight : 0) <= contentHeight;
  const rowHeight = full ? fullHeight : 26;
  const hasOverflow = omitted > 0 || lines.length > 9 || lines.length * rowHeight > contentHeight;
  // Glance limits a column to ten children, including the overflow note.
  const capacity = Math.max(
    0,
    Math.min(9, Math.floor((contentHeight - (hasOverflow ? overflowHeight : 0)) / rowHeight)),
  );
  const shown = lines.slice(0, capacity);
  const hidden = omitted + lines.length - shown.length;
  const bar = (remaining: number, color = colors.primary) => (
    <LinearProgressIndicator
      progress={remaining / 100}
      color={remaining <= 10 ? colors.error : color}
      trackColor={colors.surfaceVariant}
      modifiers={[fillMaxWidth(), height(6)]}
    />
  );

  return (
    // Android lacks widgetURL; one card Button routes taps to the app listener opening props.url.
    <Button
      colors={{ containerColor: colors.surface }}
      modifiers={[fillMaxSize()]}
      onClick={() => {}}
    >
      <Column modifiers={[fillMaxSize(), paddingAll(inset)]}>
        <Column modifiers={[fillMaxWidth(), height(contentHeight)]}>
          {shown.map(({ provider, position, window, detail }) => {
            if (!window) {
              return (
                <Text
                  key={provider}
                  color={muted}
                  maxLines={1}
                  style={{ fontSize: 11 }}
                  modifiers={[height(rowHeight)]}
                >
                  {`${provider} · ${detail}`}
                </Text>
              );
            }
            const accounts = window.accounts ?? [];
            const gap = 4;
            const accountWidth =
              accounts.length > 1
                ? (contentWidth - gap * (accounts.length - 1)) / accounts.length
                : 0;
            const showAccounts = full && accounts.length <= 5 && accountWidth >= 64;
            return (
              <Column
                key={`${provider}-${position}`}
                modifiers={[fillMaxWidth(), height(rowHeight)]}
              >
                <Text
                  color={window.remaining <= 10 ? colors.error : colors.onSurface}
                  maxLines={1}
                  style={{ fontSize: 11, fontWeight: "bold" }}
                >
                  {`${provider} · ${window.label} · ${window.remaining}% left`}
                </Text>
                {showAccounts ? (
                  <Row modifiers={[fillMaxWidth()]}>
                    {accounts.map((account, index) => (
                      <Column
                        key={account.name}
                        modifiers={[
                          width(accountWidth + (index === 0 ? 0 : gap)),
                          padding(index === 0 ? 0 : gap, 0, 0, 0),
                        ]}
                      >
                        <Text color={muted} maxLines={1} style={{ fontSize: 10 }}>
                          {`${account.name} · ${account.remaining === undefined ? "No reading" : `${account.remaining}%`}`}
                        </Text>
                        {account.remaining === undefined
                          ? null
                          : bar(account.remaining, account.color)}
                      </Column>
                    ))}
                  </Row>
                ) : (
                  bar(window.remaining)
                )}
                {full ? (
                  <Text color={muted} maxLines={1} style={{ fontSize: 10 }}>
                    {window.reset}
                  </Text>
                ) : null}
              </Column>
            );
          })}
          {hidden > 0 ? (
            <Text
              color={muted}
              maxLines={1}
              style={{ fontSize: 10 }}
              modifiers={[height(overflowHeight)]}
            >
              {`${hidden} more in GOAT`}
            </Text>
          ) : null}
        </Column>
        <Text
          color={muted}
          maxLines={1}
          style={{ fontSize: 10 }}
          modifiers={[height(footerHeight)]}
        >
          {props.checkedAt
            ? `As of ${new Date(props.checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`
            : "Tap to connect in GOAT"}
        </Text>
      </Column>
    </Button>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);

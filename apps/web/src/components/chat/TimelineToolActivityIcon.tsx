import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  type EnvironmentId,
  type ToolActivityIcon,
  type ToolActivityNativeAppReference,
} from "@goat/contracts";
import { toolActivityFaviconUrl } from "@goat/shared/favicon";
import { getProjectFaviconCacheKey } from "@goat/shared/projectFavicon";
import { type ReactNode, use, useState } from "react";
import { GoatWordmark } from "../GoatWordmark";
import {
  BotIcon,
  BrainIcon,
  BrowserIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  MessageCircleIcon,
  SearchIcon,
  SmartphoneIcon,
  TerminalIcon,
  HammerIcon,
  WrenchIcon,
  CodeIcon as Code2Icon,
  FileDiffIcon,
  FolderIcon,
  XIcon,
  ZapIcon,
} from "~/components/solar";
import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "~/lib/utils";
import { TimelineRowCtx } from "./timelineRowContext";

export const failedToolIconClassName = "text-tool-error-icon/40";

export function toolIconAcceptsTint(toolIcon: ToolActivityIcon | undefined): boolean {
  return toolIcon === undefined;
}

export type WorkEntryIconName =
  | "bot"
  | "brain"
  | "browser"
  | "check"
  | "circle-alert"
  | "computer"
  | "code"
  | "device"
  | "eye"
  | "folder"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "pull-request"
  | "t3-code"
  | "wrench"
  | "x"
  | "zap";

export function ToolActivityIconView(props: {
  icon: ToolActivityIcon | undefined;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const fallbackClassName = cn(props.className, props.muted && "opacity-70 light:brightness-60");
  if (!props.icon) {
    return <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />;
  }
  if (props.icon._tag === "website") {
    const src = toolActivityFaviconUrl(props.icon, resolvedTheme, 32);
    return src ? (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallback={<WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />}
        className={props.className}
        muted={props.muted}
      />
    ) : (
      <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />
    );
  }
  if (props.icon._tag === "themed-logo") {
    const src =
      resolvedTheme === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallback={<WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />}
        className={props.className}
        muted={props.muted}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      app={props.icon.app}
      fallbackName={props.fallbackName}
      className={cn(props.className, "size-5")}
      muted={props.muted}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  app: ToolActivityNativeAppReference;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  return (
    <NativeAppIcon
      environmentId={activeThreadEnvironmentId}
      app={props.app}
      className={props.className}
      muted={props.muted}
      fallback={
        <WorkEntryIcon
          name={props.fallbackName}
          className={cn(props.className, props.muted && "opacity-70 light:brightness-60")}
        />
      }
    />
  );
}

/**
 * A native app's icon as its environment's host draws it, the one timeline rows show; `fallback`
 * until it loads, and when the host has none. `bare` drops the tile behind it.
 */
export function NativeAppIcon(props: {
  environmentId: EnvironmentId;
  app: ToolActivityNativeAppReference;
  className: string;
  fallback: ReactNode;
  muted?: boolean;
  bare?: boolean;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "native-app-icon",
    app: props.app,
  });
  if (asset._tag !== "Success") return props.fallback;
  const cacheKey = getProjectFaviconCacheKey(
    props.environmentId,
    JSON.stringify(props.app),
    asset.url,
  );
  return (
    <ToolActivityImageIcon
      key={cacheKey}
      cacheKey={cacheKey}
      src={asset.url}
      fallback={props.fallback}
      className={props.className}
      muted={props.muted ?? false}
      bare={props.bare ?? false}
    />
  );
}

const loadedToolActivityIconSrcs = new Map<string, string>();

function ToolActivityImageIcon(props: {
  cacheKey: string;
  src: string;
  fallback: ReactNode;
  className: string;
  muted: boolean;
  bare?: boolean;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedToolActivityIconSrcs.get(props.cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== props.src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedToolActivityIconSrcs.get(props.cacheKey) === failedSrc) {
      loadedToolActivityIconSrcs.delete(props.cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };
  return (
    <>
      {displayedSrc === null ? props.fallback : null}
      {displayedSrc ? (
        <span
          className={cn(
            props.className,
            "inline-block overflow-hidden",
            !props.bare && "rounded-xs bg-background",
            props.muted && "dark:opacity-70",
          )}
        >
          <img
            src={displayedSrc}
            alt=""
            aria-hidden
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn("block size-full object-contain", props.muted && "light:brightness-70")}
            onError={() => handleLoadError(displayedSrc)}
          />
        </span>
      ) : null}
      {isLoading ? (
        <img
          src={props.src}
          alt=""
          aria-hidden
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden"
          onLoad={() => {
            loadedToolActivityIconSrcs.set(props.cacheKey, props.src);
            setDisplayedSrc(props.src);
          }}
          onError={() => handleLoadError(props.src)}
        />
      ) : null}
    </>
  );
}

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "pull-request":
      return <PullRequestGlyph.pullRequest className={className} aria-hidden />;
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "browser":
    case "computer":
      return <BrowserIcon className={className} aria-hidden />;
    case "code":
      return <Code2Icon className={className} aria-hidden />;
    case "device":
      return <SmartphoneIcon className={className} aria-hidden />;
    case "t3-code":
      return <GoatWordmark className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "folder":
      return <FolderIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <FileDiffIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

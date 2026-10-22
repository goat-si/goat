/**
 * The app's icon vocabulary. Every glyph is Solar Linear (Solar by 480 Design, CC BY 4.0),
 * bundled offline through solar.generated.ts. Import icons from here; to add one, map a
 * name to a Solar Linear glyph below and run `node apps/web/scripts/generate-solar-icons.ts`.
 */
import { createElement, type ReactElement, type ReactNode, type SVGProps } from "react";

import type { IconNode } from "./iconNode";
import * as solar from "./solar.generated";

export interface IconProps extends SVGProps<SVGSVGElement> {
  readonly size?: number | string;
  /** Accepted for call-site compatibility; Solar glyphs keep their own stroke weight. */
  readonly absoluteStrokeWidth?: boolean;
}

export type IconComponent = ((props: IconProps) => ReactElement) & { displayName?: string };

function reactAttributes(attrs: IconNode[number][1], key: number) {
  const props: Record<string, string | number> = { key };
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    props[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return props;
}

/** Builds a lucide-compatible component that draws one Solar Linear glyph. */
function solarIcon(node: IconNode, displayName: string): IconComponent {
  // Built on first draw and shared by every instance of this icon.
  let children: ReactNode[] | undefined;
  const glyph = () =>
    (children ??= node.map(([tag, attrs], index) =>
      createElement(tag, reactAttributes(attrs, index)),
    ));
  const Icon: IconComponent = ({
    size = 24,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    children: extraChildren,
    ...props
  }) => {
    const labelled =
      props["aria-label"] !== undefined ||
      props["aria-labelledby"] !== undefined ||
      props.role !== undefined;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden={labelled ? undefined : true}
        data-icon={displayName}
        {...props}
      >
        {glyph()}
        {extraChildren}
      </svg>
    );
  };
  Icon.displayName = displayName;
  return Icon;
}

export const ActivityIcon = /* @__PURE__ */ solarIcon(solar.pulse, "ActivityIcon");
export const AlarmClockIcon = /* @__PURE__ */ solarIcon(solar.alarm, "AlarmClockIcon");
export const AlarmClockOffIcon = /* @__PURE__ */ solarIcon(solar.alarmTurnOff, "AlarmClockOffIcon");
export const ArchiveIcon = /* @__PURE__ */ solarIcon(solar.archive, "ArchiveIcon");
export const ArchiveXIcon = /* @__PURE__ */ solarIcon(solar.archiveUp, "ArchiveXIcon");
export const ArrowDownIcon = /* @__PURE__ */ solarIcon(solar.arrowDown, "ArrowDownIcon");
export const ArrowDownUpIcon = /* @__PURE__ */ solarIcon(solar.sortVertical, "ArrowDownUpIcon");
export const ArrowLeftIcon = /* @__PURE__ */ solarIcon(solar.arrowLeft, "ArrowLeftIcon");
export const ArrowRightIcon = /* @__PURE__ */ solarIcon(solar.arrowRight, "ArrowRightIcon");
export const ArrowRightLeftIcon = /* @__PURE__ */ solarIcon(
  solar.transferHorizontal,
  "ArrowRightLeftIcon",
);
export const ArrowUpIcon = /* @__PURE__ */ solarIcon(solar.arrowUp, "ArrowUpIcon");
export const ArrowUpDownIcon = /* @__PURE__ */ solarIcon(solar.sortVertical, "ArrowUpDownIcon");
export const ArrowUpFromLineIcon = /* @__PURE__ */ solarIcon(
  solar.arrowUpFromLine,
  "ArrowUpFromLineIcon",
);
export const ArrowUpLeftIcon = /* @__PURE__ */ solarIcon(solar.arrowLeftUp, "ArrowUpLeftIcon");
export const ArrowUpRightIcon = /* @__PURE__ */ solarIcon(solar.arrowRightUp, "ArrowUpRightIcon");
export const BatteryIcon = /* @__PURE__ */ solarIcon(solar.batteryFull, "BatteryIcon");
export const BellIcon = /* @__PURE__ */ solarIcon(solar.bell, "BellIcon");
export const BlocksIcon = /* @__PURE__ */ solarIcon(solar.blocks, "BlocksIcon");
export const BookOpenIcon = /* @__PURE__ */ solarIcon(solar.book, "BookOpenIcon");
export const BoldIcon = /* @__PURE__ */ solarIcon(solar.textBold, "BoldIcon");
export const BookmarkIcon = /* @__PURE__ */ solarIcon(solar.bookmark, "BookmarkIcon");
export const BotIcon = /* @__PURE__ */ solarIcon(solar.ghost, "BotIcon");
export const BoxIcon = /* @__PURE__ */ solarIcon(solar.box, "BoxIcon");
export const BrowserIcon = /* @__PURE__ */ solarIcon(solar.windowFrame, "BrowserIcon");
export const BrainIcon = /* @__PURE__ */ solarIcon(solar.brain, "BrainIcon");
export const BugIcon = /* @__PURE__ */ solarIcon(solar.bug, "BugIcon");
export const CalendarArrowDownIcon = /* @__PURE__ */ solarIcon(
  solar.sortFromTopToBottom,
  "CalendarArrowDownIcon",
);
export const CalendarArrowUpIcon = /* @__PURE__ */ solarIcon(
  solar.sortFromBottomToTop,
  "CalendarArrowUpIcon",
);
export const CalendarClockIcon = /* @__PURE__ */ solarIcon(solar.calendarMark, "CalendarClockIcon");
export const CalendarIcon = /* @__PURE__ */ solarIcon(solar.calendar, "CalendarIcon");
export const CameraIcon = /* @__PURE__ */ solarIcon(solar.camera, "CameraIcon");
export const ChartNoAxesColumnIcon = /* @__PURE__ */ solarIcon(
  solar.chart2,
  "ChartNoAxesColumnIcon",
);
export const CheckIcon = /* @__PURE__ */ solarIcon(solar.check, "CheckIcon");
export const ChevronDownIcon = /* @__PURE__ */ solarIcon(solar.altArrowDown, "ChevronDownIcon");
export const ChevronLeftIcon = /* @__PURE__ */ solarIcon(solar.altArrowLeft, "ChevronLeftIcon");
export const ChevronRightIcon = /* @__PURE__ */ solarIcon(solar.altArrowRight, "ChevronRightIcon");
export const ChevronUpIcon = /* @__PURE__ */ solarIcon(solar.altArrowUp, "ChevronUpIcon");
export const ChevronsLeftRightEllipsisIcon = /* @__PURE__ */ solarIcon(
  solar.chevronsLeftRightEllipsis,
  "ChevronsLeftRightEllipsisIcon",
);
export const ChevronsUpDownIcon = /* @__PURE__ */ solarIcon(
  solar.chevronsUpDown,
  "ChevronsUpDownIcon",
);
export const CircleIcon = /* @__PURE__ */ solarIcon(solar.record, "CircleIcon");
export const CircleAlertIcon = /* @__PURE__ */ solarIcon(solar.dangerCircle, "CircleAlertIcon");
export const CircleArrowUpIcon = /* @__PURE__ */ solarIcon(solar.roundArrowUp, "CircleArrowUpIcon");
export const CircleCheckIcon = /* @__PURE__ */ solarIcon(solar.checkCircle, "CircleCheckIcon");
export const CircleDashedIcon = /* @__PURE__ */ solarIcon(solar.circleDashed, "CircleDashedIcon");
export const CircleDotIcon = /* @__PURE__ */ solarIcon(solar.circleDot, "CircleDotIcon");
export const CircleSlashIcon = /* @__PURE__ */ solarIcon(solar.forbiddenCircle, "CircleSlashIcon");
export const CircleXIcon = /* @__PURE__ */ solarIcon(solar.closeCircle, "CircleXIcon");
export const ClockIcon = /* @__PURE__ */ solarIcon(solar.clockCircle, "ClockIcon");
export const CloudDownloadIcon = /* @__PURE__ */ solarIcon(
  solar.cloudDownload,
  "CloudDownloadIcon",
);
export const CloudIcon = /* @__PURE__ */ solarIcon(solar.cloud, "CloudIcon");
export const CloudUploadIcon = /* @__PURE__ */ solarIcon(solar.cloudUpload, "CloudUploadIcon");
export const CodeIcon = /* @__PURE__ */ solarIcon(solar.code, "CodeIcon");
export const Columns2Icon = /* @__PURE__ */ solarIcon(solar.columns2, "Columns2Icon");
export const CopyIcon = /* @__PURE__ */ solarIcon(solar.copy, "CopyIcon");
export const CornerLeftUpIcon = /* @__PURE__ */ solarIcon(solar.arrowToTopLeft, "CornerLeftUpIcon");
export const CornerUpRightIcon = /* @__PURE__ */ solarIcon(solar.forward, "CornerUpRightIcon");
export const CpuIcon = /* @__PURE__ */ solarIcon(solar.cpu, "CpuIcon");
export const DatabaseIcon = /* @__PURE__ */ solarIcon(solar.database, "DatabaseIcon");
export const DownloadIcon = /* @__PURE__ */ solarIcon(solar.download, "DownloadIcon");
export const EllipsisIcon = /* @__PURE__ */ solarIcon(solar.menuDots, "EllipsisIcon");
export const ExternalLinkIcon = /* @__PURE__ */ solarIcon(
  solar.squareArrowRightUp,
  "ExternalLinkIcon",
);
export const EyeIcon = /* @__PURE__ */ solarIcon(solar.eye, "EyeIcon");
export const EyeOffIcon = /* @__PURE__ */ solarIcon(solar.eyeClosed, "EyeOffIcon");
export const FileCodeIcon = /* @__PURE__ */ solarIcon(solar.fileCode, "FileCodeIcon");
export const FileDiffIcon = /* @__PURE__ */ solarIcon(solar.documentText, "FileDiffIcon");
export const FileIcon = /* @__PURE__ */ solarIcon(solar.file, "FileIcon");
export const FileJsonIcon = /* @__PURE__ */ solarIcon(solar.fileBraces, "FileJsonIcon");
export const FileSearchIcon = /* @__PURE__ */ solarIcon(solar.fileSearch, "FileSearchIcon");
export const FileSpreadsheetIcon = /* @__PURE__ */ solarIcon(
  solar.fileSpreadsheet,
  "FileSpreadsheetIcon",
);
export const FileTextIcon = /* @__PURE__ */ solarIcon(solar.fileText, "FileTextIcon");
export const FilesIcon = /* @__PURE__ */ solarIcon(solar.documents, "FilesIcon");
export const FilmIcon = /* @__PURE__ */ solarIcon(solar.clapperboardPlay, "FilmIcon");
export const FlaskConicalIcon = /* @__PURE__ */ solarIcon(solar.testTube, "FlaskConicalIcon");
export const FolderClosedIcon = /* @__PURE__ */ solarIcon(solar.folder, "FolderClosedIcon");
export const FolderGitIcon = /* @__PURE__ */ solarIcon(solar.folderGit, "FolderGitIcon");
export const FolderIcon = /* @__PURE__ */ solarIcon(solar.folder, "FolderIcon");
export const FolderOpenIcon = /* @__PURE__ */ solarIcon(solar.folderOpen, "FolderOpenIcon");
export const FolderPlusIcon = /* @__PURE__ */ solarIcon(solar.addFolder, "FolderPlusIcon");
export const FolderTreeIcon = /* @__PURE__ */ solarIcon(solar.folderTree, "FolderTreeIcon");
export const FolderWithFilesIcon = /* @__PURE__ */ solarIcon(
  solar.folderWithFiles,
  "FolderWithFilesIcon",
);
export const GaugeIcon = /* @__PURE__ */ solarIcon(solar.speedometerMiddle, "GaugeIcon");
export const GitBranchIcon = /* @__PURE__ */ solarIcon(solar.gitBranch, "GitBranchIcon");
export const GitBranchPlusIcon = /* @__PURE__ */ solarIcon(solar.gitBranch, "GitBranchPlusIcon");
export const GitCommitIcon = /* @__PURE__ */ solarIcon(solar.gitCommit, "GitCommitIcon");
export const GitForkIcon = /* @__PURE__ */ solarIcon(solar.gitFork, "GitForkIcon");
export const GitMergeIcon = /* @__PURE__ */ solarIcon(solar.gitGraph, "GitMergeIcon");
export const GitPullRequestArrowIcon = /* @__PURE__ */ solarIcon(
  solar.gitPullRequest,
  "GitPullRequestArrowIcon",
);
export const GitPullRequestClosedIcon = /* @__PURE__ */ solarIcon(
  solar.gitPullRequest,
  "GitPullRequestClosedIcon",
);
export const GitPullRequestDraftIcon = /* @__PURE__ */ solarIcon(
  solar.gitPullRequest,
  "GitPullRequestDraftIcon",
);
export const GlobeIcon = /* @__PURE__ */ solarIcon(solar.global, "GlobeIcon");
export const GripVerticalIcon = /* @__PURE__ */ solarIcon(solar.gripVertical, "GripVerticalIcon");
export const HammerIcon = /* @__PURE__ */ solarIcon(solar.toolbox, "HammerIcon");
export const HardDriveIcon = /* @__PURE__ */ solarIcon(solar.ssdRound, "HardDriveIcon");
export const HistoryIcon = /* @__PURE__ */ solarIcon(solar.history, "HistoryIcon");
export const HomeIcon = /* @__PURE__ */ solarIcon(solar.home, "HomeIcon");
export const ImageIcon = /* @__PURE__ */ solarIcon(solar.gallery, "ImageIcon");
export const InboxIcon = /* @__PURE__ */ solarIcon(solar.inbox, "InboxIcon");
export const InfoIcon = /* @__PURE__ */ solarIcon(solar.infoCircle, "InfoIcon");
export const KeyboardIcon = /* @__PURE__ */ solarIcon(solar.keyboard, "KeyboardIcon");
export const LaptopIcon = /* @__PURE__ */ solarIcon(solar.laptop, "LaptopIcon");
export const LayersIcon = /* @__PURE__ */ solarIcon(solar.layers, "LayersIcon");
export const LightbulbIcon = /* @__PURE__ */ solarIcon(solar.lightbulb, "LightbulbIcon");
export const LinkIcon = /* @__PURE__ */ solarIcon(solar.link, "LinkIcon");
export const ListIcon = /* @__PURE__ */ solarIcon(solar.list, "ListIcon");
export const ListChecksIcon = /* @__PURE__ */ solarIcon(solar.listCheck, "ListChecksIcon");
export const ListFilterIcon = /* @__PURE__ */ solarIcon(solar.filter, "ListFilterIcon");
export const ListOrderedIcon = /* @__PURE__ */ solarIcon(solar.listOrdered, "ListOrderedIcon");
export const ListTodoIcon = /* @__PURE__ */ solarIcon(solar.checklist, "ListTodoIcon");
export const LoaderCircleIcon = /* @__PURE__ */ solarIcon(solar.loader, "LoaderCircleIcon");
export const LockIcon = /* @__PURE__ */ solarIcon(solar.lock, "LockIcon");
export const LogInIcon = /* @__PURE__ */ solarIcon(solar.login, "LogInIcon");
export const MailIcon = /* @__PURE__ */ solarIcon(solar.letter, "MailIcon");
export const MaximizeIcon = /* @__PURE__ */ solarIcon(solar.maximize, "MaximizeIcon");
export const MemoryStickIcon = /* @__PURE__ */ solarIcon(solar.sdCard, "MemoryStickIcon");
export const MessageCircleIcon = /* @__PURE__ */ solarIcon(solar.chatRound, "MessageCircleIcon");
export const MessageCircleQuestionIcon = /* @__PURE__ */ solarIcon(
  solar.chatRoundQuestionMark,
  "MessageCircleQuestionIcon",
);
export const MessageSquareDashedIcon = /* @__PURE__ */ solarIcon(
  solar.chatSquare,
  "MessageSquareDashedIcon",
);
export const MessageSquareIcon = /* @__PURE__ */ solarIcon(
  solar.chatRoundDots,
  "MessageSquareIcon",
);
export const MessageSquareOffIcon = /* @__PURE__ */ solarIcon(
  solar.chatRoundOff,
  "MessageSquareOffIcon",
);
export const MessageSquareWarningIcon = /* @__PURE__ */ solarIcon(
  solar.chatRoundWarning,
  "MessageSquareWarningIcon",
);
export const MessagesSquareIcon = /* @__PURE__ */ solarIcon(
  solar.chatRoundDots,
  "MessagesSquareIcon",
);
export const MinimizeIcon = /* @__PURE__ */ solarIcon(solar.minimize, "MinimizeIcon");
export const MinusIcon = /* @__PURE__ */ solarIcon(solar.minus, "MinusIcon");
export const MonitorIcon = /* @__PURE__ */ solarIcon(solar.monitor, "MonitorIcon");
export const MoonIcon = /* @__PURE__ */ solarIcon(solar.moon, "MoonIcon");
export const MoreVerticalIcon = /* @__PURE__ */ solarIcon(
  solar.menuDotsVertical,
  "MoreVerticalIcon",
);
export const MousePointerIcon = /* @__PURE__ */ solarIcon(solar.cursor, "MousePointerIcon");
export const MousePointerClickIcon = /* @__PURE__ */ solarIcon(
  solar.cursorSquare,
  "MousePointerClickIcon",
);
export const OctagonAlertIcon = /* @__PURE__ */ solarIcon(solar.danger, "OctagonAlertIcon");
export const PackageIcon = /* @__PURE__ */ solarIcon(solar.box, "PackageIcon");
export const PackagePlusIcon = /* @__PURE__ */ solarIcon(solar.boxMinimalistic, "PackagePlusIcon");
export const PaintbrushIcon = /* @__PURE__ */ solarIcon(solar.paintBrush, "PaintbrushIcon");
export const PaletteIcon = /* @__PURE__ */ solarIcon(solar.palette, "PaletteIcon");
export const PanelBottomIcon = /* @__PURE__ */ solarIcon(solar.panelBottom, "PanelBottomIcon");
export const PanelRightIcon = /* @__PURE__ */ solarIcon(solar.panelRight, "PanelRightIcon");
export const PaperclipIcon = /* @__PURE__ */ solarIcon(solar.paperclip, "PaperclipIcon");
export const PenLineIcon = /* @__PURE__ */ solarIcon(solar.pen2, "PenLineIcon");
export const PencilIcon = /* @__PURE__ */ solarIcon(solar.pen, "PencilIcon");
export const PencilRulerIcon = /* @__PURE__ */ solarIcon(solar.rulerPen, "PencilRulerIcon");
export const PictureInPictureIcon = /* @__PURE__ */ solarIcon(solar.pip, "PictureInPictureIcon");
export const PilcrowIcon = /* @__PURE__ */ solarIcon(solar.paragraphSpacing, "PilcrowIcon");
export const PinIcon = /* @__PURE__ */ solarIcon(solar.pin, "PinIcon");
export const PinOffIcon = /* @__PURE__ */ solarIcon(solar.pin, "PinOffIcon");
export const PlayIcon = /* @__PURE__ */ solarIcon(solar.play, "PlayIcon");
export const PlugIcon = /* @__PURE__ */ solarIcon(solar.plugCircle, "PlugIcon");
export const PlusIcon = /* @__PURE__ */ solarIcon(solar.add, "PlusIcon");
export const PowerIcon = /* @__PURE__ */ solarIcon(solar.power, "PowerIcon");
export const PresentationIcon = /* @__PURE__ */ solarIcon(
  solar.presentationGraph,
  "PresentationIcon",
);
export const QrCodeIcon = /* @__PURE__ */ solarIcon(solar.qrCode, "QrCodeIcon");
export const QuoteIcon = /* @__PURE__ */ solarIcon(solar.quote, "QuoteIcon");
export const RadioTowerIcon = /* @__PURE__ */ solarIcon(solar.station, "RadioTowerIcon");
export const RedoIcon = /* @__PURE__ */ solarIcon(solar.undoRight, "RedoIcon");
export const RefreshCwIcon = /* @__PURE__ */ solarIcon(solar.refresh, "RefreshCwIcon");
export const RocketIcon = /* @__PURE__ */ solarIcon(solar.rocket, "RocketIcon");
export const RotateCcwIcon = /* @__PURE__ */ solarIcon(solar.restart, "RotateCcwIcon");
export const RotateCwIcon = /* @__PURE__ */ solarIcon(solar.refresh, "RotateCwIcon");
export const RouteIcon = /* @__PURE__ */ solarIcon(solar.route, "RouteIcon");
export const Rows3Icon = /* @__PURE__ */ solarIcon(solar.rows3, "Rows3Icon");
export const ScreenRotationIcon = /* @__PURE__ */ solarIcon(
  solar.smartphoneRotateAngle,
  "ScreenRotationIcon",
);
export const ScaleIcon = /* @__PURE__ */ solarIcon(solar.scale, "ScaleIcon");
export const SearchIcon = /* @__PURE__ */ solarIcon(solar.magnifer, "SearchIcon");
export const SendIcon = /* @__PURE__ */ solarIcon(solar.plain, "SendIcon");
export const ServerIcon = /* @__PURE__ */ solarIcon(solar.server, "ServerIcon");
export const Settings2Icon = /* @__PURE__ */ solarIcon(solar.tuning2, "Settings2Icon");
export const SettingsIcon = /* @__PURE__ */ solarIcon(solar.settings, "SettingsIcon");
export const ShieldAlertIcon = /* @__PURE__ */ solarIcon(solar.shieldWarning, "ShieldAlertIcon");
export const ShieldCheckIcon = /* @__PURE__ */ solarIcon(solar.shieldCheck, "ShieldCheckIcon");
export const ShieldIcon = /* @__PURE__ */ solarIcon(solar.shield, "ShieldIcon");
export const ShieldQuestionIcon = /* @__PURE__ */ solarIcon(
  solar.shieldKeyhole,
  "ShieldQuestionIcon",
);
export const SlidersHorizontalIcon = /* @__PURE__ */ solarIcon(
  solar.tuning,
  "SlidersHorizontalIcon",
);
export const SmartphoneIcon = /* @__PURE__ */ solarIcon(solar.smartphone, "SmartphoneIcon");
export const SmilePlusIcon = /* @__PURE__ */ solarIcon(solar.smileCircle, "SmilePlusIcon");
export const SnapShotIcon = /* @__PURE__ */ solarIcon(solar.objectScan, "SnapShotIcon");
export const SparklesIcon = /* @__PURE__ */ solarIcon(solar.stars, "SparklesIcon");
export const SquareIcon = /* @__PURE__ */ solarIcon(solar.stop, "SquareIcon");
export const SquareCodeIcon = /* @__PURE__ */ solarIcon(solar.codeSquare, "SquareCodeIcon");
export const SquareMenuIcon = /* @__PURE__ */ solarIcon(solar.hamburgerMenu, "SquareMenuIcon");
export const SquarePenIcon = /* @__PURE__ */ solarIcon(solar.penNewSquare, "SquarePenIcon");
export const SquareSplitHorizontalIcon = /* @__PURE__ */ solarIcon(
  solar.columns2,
  "SquareSplitHorizontalIcon",
);
export const SquareSplitVerticalIcon = /* @__PURE__ */ solarIcon(
  solar.rows2,
  "SquareSplitVerticalIcon",
);
export const StarIcon = /* @__PURE__ */ solarIcon(solar.star, "StarIcon");
export const SunIcon = /* @__PURE__ */ solarIcon(solar.sun, "SunIcon");
export const TagIcon = /* @__PURE__ */ solarIcon(solar.tag, "TagIcon");
export const TargetIcon = /* @__PURE__ */ solarIcon(solar.target, "TargetIcon");
export const TerminalIcon = /* @__PURE__ */ solarIcon(solar.command, "TerminalIcon");
export const TextIcon = /* @__PURE__ */ solarIcon(solar.text, "TextIcon");
export const TextSearchIcon = /* @__PURE__ */ solarIcon(solar.fileSearch, "TextSearchIcon");
export const TextWrapIcon = /* @__PURE__ */ solarIcon(solar.listArrowDown, "TextWrapIcon");
export const TicketIcon = /* @__PURE__ */ solarIcon(solar.ticket, "TicketIcon");
export const TrashIcon = /* @__PURE__ */ solarIcon(solar.trashBinMinimalistic, "TrashIcon");
export const TrendingDownIcon = /* @__PURE__ */ solarIcon(solar.graphDown, "TrendingDownIcon");
export const TrendingUpIcon = /* @__PURE__ */ solarIcon(solar.graphUp, "TrendingUpIcon");
export const TriangleAlertIcon = /* @__PURE__ */ solarIcon(
  solar.dangerTriangle,
  "TriangleAlertIcon",
);
export const UndoIcon = /* @__PURE__ */ solarIcon(solar.undoLeft, "UndoIcon");
export const UnlinkIcon = /* @__PURE__ */ solarIcon(solar.unlink, "UnlinkIcon");
export const UnplugIcon = /* @__PURE__ */ solarIcon(solar.unlinkMinimalistic, "UnplugIcon");
export const UploadIcon = /* @__PURE__ */ solarIcon(solar.upload, "UploadIcon");
export const UserCheckIcon = /* @__PURE__ */ solarIcon(solar.userCheck, "UserCheckIcon");
export const UserLockIcon = /* @__PURE__ */ solarIcon(solar.shieldUser, "UserLockIcon");
export const UserPlusIcon = /* @__PURE__ */ solarIcon(solar.userPlus, "UserPlusIcon");
export const UserRoundIcon = /* @__PURE__ */ solarIcon(solar.userRounded, "UserRoundIcon");
export const UserRoundXIcon = /* @__PURE__ */ solarIcon(solar.userCrossRounded, "UserRoundXIcon");
export const UsersIcon = /* @__PURE__ */ solarIcon(solar.usersGroupRounded, "UsersIcon");
export const WifiOffIcon = /* @__PURE__ */ solarIcon(solar.wiFiOff, "WifiOffIcon");
export const WorkflowIcon = /* @__PURE__ */ solarIcon(solar.structure, "WorkflowIcon");
export const WrenchIcon = /* @__PURE__ */ solarIcon(solar.settingsMinimalistic, "WrenchIcon");
export const XIcon = /* @__PURE__ */ solarIcon(solar.close, "XIcon");
export const ZapIcon = /* @__PURE__ */ solarIcon(solar.bolt, "ZapIcon");

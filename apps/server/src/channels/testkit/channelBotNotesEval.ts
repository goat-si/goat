/**
 * A fixed evaluation set for which GOAT Bot notes reach the bot: synthetic filler notes, planted
 * notes, and messages naming the planted notes a person would expect the bot to use. A replaced
 * note never counts; its newest replacement does.
 */
import { NOTES_HEADER, replacesMarker } from "../channelBotNoteLines.ts";

export type EvalKind =
  | "exact"
  | "paraphrase"
  | "korean"
  | "correction"
  | "multi"
  | "distractor"
  | "irrelevant";

export interface Planted {
  readonly id: string;
  readonly text: string;
  /** Where the note sits among the filler lines, from 0 (oldest) to 1 (newest). */
  readonly at: number;
  readonly replaces?: string;
}

const PLANTED: ReadonlyArray<Planted> = [
  {
    id: "deploy",
    at: 0.03,
    text: "Production deploys go out only from the release branch, after the staging smoke test passes.",
  },
  {
    id: "pr-language",
    at: 0.07,
    text: "Write pull request descriptions in Korean, with a one-line English summary at the end.",
  },
  {
    id: "billing-key",
    at: 0.11,
    text: "The billing API key is kept in the 1Password vault named Ops; never put it in .env files.",
  },
  {
    id: "standup",
    at: 0.15,
    text: "Standup is at 10:30 KST on weekdays; post the async update in #team-sync by 10:15.",
  },
  {
    id: "pnpm",
    at: 0.19,
    text: "Use pnpm in the legacy-dashboard repository; every other repository uses vp.",
  },
  {
    id: "testflight",
    at: 0.23,
    text: "Mina owns the iOS release checklist; ask her before submitting a TestFlight build.",
  },
  {
    id: "migrations",
    at: 0.27,
    text: "Database migrations need a backup snapshot first and must run outside business hours.",
  },
  {
    id: "invoices",
    at: 0.31,
    text: "Invoices go to accounting@lidge.example on the last business day of each month.",
  },
  {
    id: "force-push",
    at: 0.35,
    text: "Never force-push to dev; open a revert pull request instead.",
  },
  {
    id: "staging-host",
    at: 0.39,
    text: "The staging server is staging-02 in Seoul; staging-01 was retired.",
  },
  {
    id: "acme",
    at: 0.43,
    text: "Call the customer Acme Logistics by their short name ACL in reports.",
  },
  {
    id: "screenshots",
    at: 0.47,
    text: "Screenshots for pull requests are taken in dark mode at 1440 pixels wide.",
  },
  {
    id: "nightly",
    at: 0.51,
    text: "When a nightly build fails, open an issue labeled release-blocker and tag Daniel.",
  },
  {
    id: "dinner",
    at: 0.55,
    text: "Jun is vegetarian; book restaurants with vegetarian options for team dinners.",
  },
  {
    id: "cloud-spend",
    at: 0.59,
    text: "Monthly cloud spend above 2,000 dollars needs approval from Hyejin.",
  },
  {
    id: "weekly-report",
    at: 0.05,
    text: "주간 보고서는 금요일 오후 5시까지 노션 팀 페이지에 올려 주세요.",
  },
  {
    id: "maintenance",
    at: 0.17,
    text: "서버 정기 점검은 매월 첫째 주 일요일 새벽 2시에 진행합니다.",
  },
  { id: "support-reply", at: 0.29, text: "고객 문의 답장은 존댓말로, 24시간 안에 보내 주세요." },
  { id: "vacation", at: 0.41, text: "휴가 신청은 최소 일주일 전에 슬랙 #휴가 채널에 남겨 주세요." },
  {
    id: "design-review",
    at: 0.53,
    text: "디자인 리뷰는 화요일 오후에 피그마 링크와 함께 요청해요.",
  },
  { id: "receipts", at: 0.65, text: "법인카드 영수증은 사용한 날 바로 경비 앱에 올려요." },
  { id: "summary-1", at: 0.09, text: "Send the weekly summary to Mina." },
  { id: "summary-2", at: 0.37, text: "Send the weekly summary to Hyejin.", replaces: "summary-1" },
  {
    id: "summary-3",
    at: 0.71,
    text: "Send the weekly summary to Daniel and Hyejin.",
    replaces: "summary-2",
  },
  { id: "freeze-1", at: 0.21, text: "Code freeze starts on December 18." },
  { id: "freeze-2", at: 0.61, text: "Code freeze starts on December 20.", replaces: "freeze-1" },
  { id: "deploy-channel-1", at: 0.13, text: "배포 알림은 #deploy 채널에 올려요." },
  {
    id: "deploy-channel-2",
    at: 0.75,
    text: "배포 알림은 #release-notes 채널에 올려요.",
    replaces: "deploy-channel-1",
  },
  { id: "node-1", at: 0.33, text: "Use Node 24 for the marketing site." },
  // The newest notes are always read, so this correction hides a note far older than they reach.
  { id: "node-2", at: 1, text: "Use Node 26 for the marketing site.", replaces: "node-1" },
];

export interface EvalMessage {
  readonly kind: EvalKind;
  readonly text: string;
  /** Planted notes the bot should see for this message. */
  readonly expected: ReadonlyArray<string>;
  /** Planted notes the bot must not be shown, because a later note replaced them. */
  readonly replaced?: ReadonlyArray<string>;
}

export interface EvalSet {
  readonly notes: ReadonlyArray<Planted>;
  readonly messages: ReadonlyArray<EvalMessage>;
}

const EVAL_MESSAGES: ReadonlyArray<EvalMessage> = [
  {
    kind: "exact",
    text: "Can you deploy the release branch to production now?",
    expected: ["deploy"],
  },
  { kind: "exact", text: "What vault is the billing API key in?", expected: ["billing-key"] },
  {
    kind: "exact",
    text: "When is standup and where do I post my async update?",
    expected: ["standup"],
  },
  {
    kind: "exact",
    text: "Which package manager do I use for the legacy-dashboard repo?",
    expected: ["pnpm"],
  },
  { kind: "exact", text: "Who should I ask about the TestFlight build?", expected: ["testflight"] },
  {
    kind: "exact",
    text: "I need to run a database migration this afternoon.",
    expected: ["migrations"],
  },
  { kind: "exact", text: "Where do invoices go at the end of the month?", expected: ["invoices"] },
  {
    kind: "exact",
    text: "Can I force-push to dev to clean up the history?",
    expected: ["force-push"],
  },
  { kind: "exact", text: "The nightly build failed again, what now?", expected: ["nightly"] },
  {
    kind: "exact",
    text: "Take screenshots for the pull request I just opened.",
    expected: ["screenshots"],
  },
  {
    kind: "exact",
    text: "Book a restaurant for the team dinner on Thursday.",
    expected: ["dinner"],
  },
  {
    kind: "exact",
    text: "Our cloud spend will pass 2,000 dollars this month, is that ok?",
    expected: ["cloud-spend"],
  },
  { kind: "paraphrase", text: "Ship the new version to prod, please.", expected: ["deploy"] },
  {
    kind: "paraphrase",
    text: "Where's the secret for payments stored?",
    expected: ["billing-key"],
  },
  { kind: "paraphrase", text: "What time is our daily morning sync?", expected: ["standup"] },
  {
    kind: "paraphrase",
    text: "Which machine is the pre-production environment on?",
    expected: ["staging-host"],
  },
  {
    kind: "paraphrase",
    text: "Write up the status update for our biggest logistics client.",
    expected: ["acme"],
  },
  { kind: "paraphrase", text: "Draft the description for my PR.", expected: ["pr-language"] },
  {
    kind: "paraphrase",
    text: "Can I change the schema on the live database at noon?",
    expected: ["migrations"],
  },
  { kind: "paraphrase", text: "Who signs off on extra AWS costs?", expected: ["cloud-spend"] },
  { kind: "korean", text: "주간 보고서 언제까지 올려야 해?", expected: ["weekly-report"] },
  { kind: "korean", text: "이번 달 서버 점검 언제야?", expected: ["maintenance"] },
  { kind: "korean", text: "고객 문의에 어떻게 답장하면 돼?", expected: ["support-reply"] },
  {
    kind: "korean",
    text: "다음 주에 휴가 쓰고 싶은데 어디에 신청해?",
    expected: ["vacation"],
  },
  { kind: "korean", text: "디자인 리뷰 요청은 언제 하면 돼?", expected: ["design-review"] },
  { kind: "korean", text: "법인카드 영수증은 어떻게 처리해?", expected: ["receipts"] },
  {
    kind: "correction",
    text: "Who gets the weekly summary?",
    expected: ["summary-3"],
    replaced: ["summary-1", "summary-2"],
  },
  {
    kind: "correction",
    text: "When does the code freeze start?",
    expected: ["freeze-2"],
    replaced: ["freeze-1"],
  },
  {
    kind: "correction",
    text: "배포 알림은 어느 채널에 올려?",
    expected: ["deploy-channel-2"],
    replaced: ["deploy-channel-1"],
  },
  {
    kind: "correction",
    text: "Which Node version for the marketing site?",
    expected: ["node-2"],
    replaced: ["node-1"],
  },
];

/** The main set: 30 planted notes and 30 messages. */
export const EVAL_SET: EvalSet = { notes: PLANTED, messages: EVAL_MESSAGES };

// The first notes measurement's generator: a deterministic random walk over a small vocabulary.
const WORDS =
  "deploy build review reply korean english pnpm draft tests staging release notes friday monday weekly summary short long format bullet links".split(
    " ",
  );

const generator = () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sentence = (min: number, max: number) => {
    const target = min + Math.floor(rand() * (max - min));
    let text = "";
    while (text.length < target) {
      text += (text ? " " : "") + WORDS[Math.floor(rand() * WORDS.length)];
    }
    return text.slice(0, target) + ".";
  };
  const inputId = () =>
    "channel-input:" +
    Array.from({ length: 32 }, () => "abcdef0123456789"[Math.floor(rand() * 16)]).join("");
  return { rand, sentence, inputId };
};

const dateOf = (day: number) =>
  // @effect-diagnostics-next-line globalDate:off -- fixed fixture dates, as the first measurement wrote them.
  new Date(Date.UTC(2026, 0, 1) + day * 3_600_000 * 6).toISOString().slice(0, 10);

/** Filler lines: 10% hand-written, 5% corrections naming a random earlier note. */
const fillerLines = (bytes: number) => {
  const { rand, sentence, inputId } = generator();
  const lines: Array<string> = [];
  const texts: Array<string> = [];
  let size = NOTES_HEADER.length;
  for (let day = 1; size < bytes; day++) {
    const date = dateOf(day);
    const roll = rand();
    let line: string;
    if (roll < 0.1) line = sentence(30, 120);
    else if (roll < 0.15 && texts.length > 0) {
      const old = texts[Math.floor(rand() * texts.length)] ?? "";
      const text = sentence(40, 200);
      texts.push(text);
      line = "- " + date + ": " + text + " (asked in " + inputId() + ")" + replacesMarker(old);
    } else {
      const text = sentence(40, 200);
      texts.push(text);
      line = "- " + date + ": " + text + " (asked in " + inputId() + ")";
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines;
};

export interface EvalNotesFile {
  /** The whole memory.md, header included. */
  readonly text: string;
  /** Each planted note's exact line, by id. */
  readonly lines: ReadonlyMap<string, string>;
}

/** A notes file of about `bytes` with every planted note of the set at its place. */
export const evalNotesFile = (bytes: number, set: EvalSet = EVAL_SET): EvalNotesFile => {
  const filler = fillerLines(bytes);
  const byId = new Map(set.notes.map((note) => [note.id, note]));
  const lines = new Map<string, string>();
  const out: Array<string> = [];
  let date = dateOf(0);
  for (let position = 0; position <= filler.length; position++) {
    for (const note of set.notes) {
      if (Math.round(note.at * filler.length) !== position) continue;
      const old = note.replaces === undefined ? undefined : byId.get(note.replaces);
      const line =
        "- " +
        date +
        ": " +
        note.text +
        " (asked in channel-input:planted-" +
        note.id +
        ")" +
        (old === undefined ? "" : replacesMarker(old.text));
      lines.set(note.id, line);
      out.push(line);
    }
    const next = filler[position];
    if (next === undefined) continue;
    out.push(next);
    date = /^- (\d{4}-\d{2}-\d{2}): /u.exec(next)?.[1] ?? date;
  }
  return { text: NOTES_HEADER + out.join("\n") + "\n", lines };
};

export interface EvalScore {
  readonly found: number;
  readonly expected: number;
  /** Replaced planted notes that were shown anyway. */
  readonly leaked: number;
  /** Planted notes shown that the message does not call for. */
  readonly extra: number;
}

/** How many expected notes `shown` holds as whole lines, and which other planted notes it shows. */
export const scoreShown = (file: EvalNotesFile, message: EvalMessage, shown: string): EvalScore => {
  const shownLines = new Set(shown.split("\n").map((line) => line.trim()));
  const has = (id: string) => {
    const line = file.lines.get(id);
    return line !== undefined && shownLines.has(line);
  };
  return {
    found: message.expected.filter(has).length,
    expected: message.expected.length,
    leaked: (message.replaced ?? []).filter(has).length,
    extra: [...file.lines.keys()].filter((id) => !message.expected.includes(id) && has(id)).length,
  };
};

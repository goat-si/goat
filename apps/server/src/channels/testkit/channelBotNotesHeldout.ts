/**
 * Held-out cases for the GOAT Bot notes evaluation, written by a separate agent that saw neither
 * the selection code nor the main set. They are scored, never tuned against.
 *
 * @module channelBotNotesHeldout
 */
import type { EvalSet } from "./channelBotNotesEval.ts";

export const HELDOUT_SET: EvalSet = {
  notes: [
    {
      id: "n01",
      at: 0.02,
      text: "Always post the deploy checklist in #release-room before shipping. (asked by Lena)",
    },
    {
      id: "n02",
      at: 0.059,
      text: "Mina prefers all bot replies in Korean, even when the question is in English.",
    },
    {
      id: "n03",
      at: 0.099,
      text: "For API incidents, page the on-call engineer using PagerDuty, not email.",
    },
    {
      id: "n04",
      at: 0.139,
      text: "Keep the billing export in /srv/finance/monthly, with restricted access.",
    },
    { id: "n05", at: 0.178, text: "팀 회의록은 공유하기 전에 반드시 지수에게 검토를 받아 주세요." },
    { id: "n06", at: 0.218, text: "민준님에게 일정 변경을 알릴 때는 서울 시간으로 적어 주세요." },
    { id: "n07", at: 0.257, text: "고객 문의 답변에는 개인 전화번호를 넣지 말아 주세요." },
    {
      id: "n08",
      at: 0.297,
      text: "디자인 시안 파일 이름은 프로젝트명과 날짜를 붙여 정리해 주세요.",
    },
    {
      id: "n09",
      at: 0.336,
      text: "The weekly infrastructure digest goes out on Monday at 09:00 UTC.",
    },
    {
      id: "n10",
      at: 0.376,
      text: "The office coffee beans are ordered from Pine Roasters every month.",
    },
    {
      id: "n11",
      at: 0.416,
      text: "For staging releases, use the #staging-release channel for status updates.",
    },
    {
      id: "n12",
      at: 0.455,
      text: "In the production release channel, tag @release-captain when the rollout begins.",
    },
    {
      id: "n13",
      at: 0.495,
      text: "Ship mobile build artifacts to the internal QA bucket, not the public downloads folder.",
    },
    {
      id: "n14",
      at: 0.534,
      text: "사무실 방문객은 도착하기 전에 로비 안내 데스크에 등록해 주세요.",
    },
    {
      id: "n15",
      at: 0.574,
      text: "Quarterly planning documents should use the template at /docs/planning-template.md.",
    },
    {
      id: "n16",
      at: 0.614,
      text: "The support team's escalation contact is Rosa in #support-triage.",
    },
    {
      id: "n17",
      at: 0.653,
      text: "서비스 장애가 끝나면 원인 분석 문서를 48시간 안에 작성해 주세요.",
    },
    {
      id: "n18",
      at: 0.69,
      text: "Order 12 vegetarian lunches for the Thursday workshop. (asked by Omar)",
    },
    {
      id: "n19",
      at: 0.732,
      text: "The weekly infrastructure digest now goes out on Wednesday at 14:00 UTC.",
      replaces: "n09",
    },
    {
      id: "n20",
      at: 0.772,
      text: "목요일 워크숍 채식 점심은 12개 대신 18개를 주문해 주세요.",
      replaces: "n18",
    },
    {
      id: "n21",
      at: 0.811,
      text: "The support escalation contact has changed to Theo in #help-escalations.",
      replaces: "n16",
    },
    {
      id: "n22",
      at: 0.851,
      text: "목요일 워크숍 채식 점심은 최종적으로 20개 주문해 주세요.",
      replaces: "n20",
    },
    {
      id: "n23",
      at: 0.891,
      text: "Release notes for production must be approved by Priya before publication.",
    },
    {
      id: "n24",
      at: 0.93,
      text: "Keep release notes for staging in the #staging-release pinned document.",
    },
  ],
  messages: [
    {
      kind: "exact",
      text: "Where should I post the deploy checklist before shipping this afternoon?",
      expected: ["n01"],
    },
    {
      kind: "exact",
      text: "Where do we keep the billing export for the monthly finance close?",
      expected: ["n04"],
    },
    {
      kind: "exact",
      text: "Which template should I use for the quarterly planning documents?",
      expected: ["n15"],
    },
    {
      kind: "exact",
      text: "Where should I send the mobile build artifacts for the QA team?",
      expected: ["n13"],
    },
    {
      kind: "paraphrase",
      text: "The backend endpoint is down and customers cannot connect. How do I get someone to respond?",
      expected: ["n03"],
    },
    {
      kind: "paraphrase",
      text: "I'm writing to Mina in English; which language should your answer use?",
      expected: ["n02"],
    },
    {
      kind: "paraphrase",
      text: "We have run out of espresso supplies again. Who is our usual supplier?",
      expected: ["n10"],
    },
    {
      kind: "paraphrase",
      text: "A production outage is over. When does the team need to finish its retrospective?",
      expected: ["n17"],
    },
    {
      kind: "korean",
      text: "팀 회의록을 다른 부서에 보내기 전에 누구에게 확인받아야 하나요?",
      expected: ["n05"],
    },
    {
      kind: "korean",
      text: "민준님께 회의 일정이 바뀌었다고 알려 드릴게요. 시간은 어느 지역 기준으로 적죠?",
      expected: ["n06"],
    },
    {
      kind: "korean",
      text: "고객 문의에 답장을 쓰고 있는데 제 개인 전화번호를 넣어도 될까요?",
      expected: ["n07"],
    },
    {
      kind: "korean",
      text: "내일 사무실에 방문객이 오는데, 오시기 전에 어디에 등록해야 해요?",
      expected: ["n14"],
    },
    {
      kind: "correction",
      text: "When should I send the weekly infrastructure digest this week?",
      expected: ["n19"],
      replaced: ["n09"],
    },
    {
      kind: "correction",
      text: "이번 목요일 워크숍에 채식 점심을 모두 몇 개 주문하면 되나요?",
      expected: ["n22"],
      replaced: ["n18", "n20"],
    },
    {
      kind: "correction",
      text: "Who handles support escalations now, and which channel should I use?",
      expected: ["n21"],
      replaced: ["n16"],
    },
    {
      kind: "multi",
      text: "Mina asked in English for our API incident response instructions. Please answer her appropriately.",
      expected: ["n02", "n03"],
    },
    {
      kind: "multi",
      text: "I'm starting a production rollout and getting its release notes ready for publication. What should I do?",
      expected: ["n12", "n23"],
    },
    {
      kind: "multi",
      text: "민준님께 변경된 일정을 알리고 팀 회의록도 공유하려고 해요. 무엇을 확인해야 하나요?",
      expected: ["n06", "n05"],
    },
    {
      kind: "distractor",
      text: "Where should I put staging release status updates while testing this deployment?",
      expected: ["n11"],
    },
    {
      kind: "distractor",
      text: "Who must approve production release notes before I publish them?",
      expected: ["n23"],
    },
    {
      kind: "distractor",
      text: "Where is the staging release notes document kept for the team to edit?",
      expected: ["n24"],
    },
    {
      kind: "irrelevant",
      text: "What did you think of the sunset over the river yesterday evening?",
      expected: [],
    },
    {
      kind: "irrelevant",
      text: "Could you explain why the moon has phases in a few simple sentences?",
      expected: [],
    },
    {
      kind: "irrelevant",
      text: "오늘 기분 전환으로 듣기 좋은 재즈 곡 하나 추천해 주실래요?",
      expected: [],
    },
  ],
};

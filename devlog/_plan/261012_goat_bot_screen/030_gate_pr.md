# 030 — 게이트와 PR (wp3)

- push 전 `git fetch origin && git rebase origin/dev`(이미 push된 브랜치이므로 `--force-with-lease`).
- 변경 파일 `node_modules/.bin/vp fmt --check <files>`와 `node_modules/.bin/vp lint <files>`, `cd apps/web && pnpm typecheck`, 관련 테스트, `cd apps/web && pnpm build`, `node_modules/.bin/vp run knip:check`(CI가 --exports로 돈다. 호출자 없는 export를 만들지 않는다).
- 독립 리뷰: 빌더(GPT-6.1-Sol)와 다른 계열(Claude) 리뷰어.
- PR: dev 대상, 제목 `feat(web): GOAT Bot messenger screen`, 본문 Refs(goat_initiative 070/040, #32), 원인, 수정, 검증. 머지하지 않는다.
- link_pull_request, 머지 관리 스레드(mcp:b2019de5-375d-4f63-87b4-c14bd804e935)에 PR 번호와 검증 요약.
- UI 증거: dev 서버에는 channelLedger가 없어 봇 화면은 미지원 안내만 보인다. 실제 말풍선·칩 스크린샷은 wp4에서 test-t3-app으로 찍어 GitHub PR에 올린다(커밋하지 않음). 첫 PR 본문에 그 사실을 적는다.
- PR 본문: dev에서는 포트가 비어 있어 봇 화면이 미지원 안내만 보이고, wp4(#32 머지 뒤)에서 포트를 채운다고 적는다.

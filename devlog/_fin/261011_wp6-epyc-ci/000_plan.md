# 261011 wp6 — EPYC self-hosted CI (핸드오프 계획, 감사 3회차 기준)

goat-si/goat CI를 EPYC self-hosted runner에서만 돌린다(GitHub-hosted 분 0). 다른 Mac 스레드(01a125a6)에서 3회 감사를 거친 계획을 이어받았고, 남은 차단 이슈는 pre-push 훅이 goat-ci.yml을 경로만 보고 허용한다는 점 하나다.

---

## 현재 상태 (2026-10-11 04:50 KST 확인)

- goat-si/goat: main = preview = 6bebb0699, dev = dfd768cb5 (SSH 파견 기능 포함). 작업 흐름은 goat/global-agent에서 main/dev/preview로 바뀌었다. goat/global-agent(aa2eaf2ff)는 오래된 브랜치다.
- Actions: {"enabled":false}, runner 0, run 0, 워크플로 18개 active.
- ChatView: ef4748eb7 "open link-started threads maximized through the right panel store"가 존재하지 않는 setter 문제를 고쳤다(web tsc 오류 0 확인). 계획 5번의 헬퍼 추가는 불필요.
- EPYC 접속: 이 Mac → dlt-studio(100.85.168.63, dlt-partners) → epyc(192.168.0.8, neuralarcade). 이 Mac 공개키를 EPYC authorized_keys에 추가함. EPYC는 publickey 인증만 허용. sudo 비밀번호는 사용자가 채팅으로 제공(출력·파일·argv 금지, stdin 한 줄로만).
- EPYC: 192 스레드, / 1.7T 여유, thingsflow runner 서비스 4개 active, neuralarcade sudo·docker 그룹.

## 순서 (GitHub-hosted 분 0)

1. 워크플로 스냅샷 저장 → 18개 PUT disable → 재조회해 goat-ci 외 전부 disabled_manually 스냅샷.
2. EPYC 준비(epyc-prepare.sh, root) → 채널 시험(len=10) → runner 2개 등록(epyc-register.sh, 각 새 토큰, ghrunner) → svc.sh install ghrunner && start → online, name→id 기록.
3. Actions enable (PUT /actions/permissions enabled=true).
4. goat-ci.yml + .vite-hooks/pre-push(+테스트) 커밋을 dev에 push → push 트리거로 goat-ci 실행. workflow_dispatch에 의존하지 않음.

## goat-ci.yml (감사본, 브랜치만 조정 대상)

on.push.branches [main, "goat/**"] → [main, dev, preview, "goat/**"], pull_request.branches [main] → [main, dev]. 나머지는 핸드오프 전문과 동일(jobs.ci 매트릭스 check/typecheck/test/build, runs-on [self-hosted, linux, x64, goat, epyc], steps uses = actions/checkout@v6, voidzero-dev/setup-vp@v1, actions/upload-artifact@v4, artifact goat-desktop-build 3일 보존).

## pre-push 차단 이슈 수정 요구

각 pushed tip의 goat-ci.yml 구조 검증: on ⊆ {push, pull_request, workflow_dispatch}, jobs는 ci 하나, job 수준 uses 없음, runs-on 정확히 [self-hosted, linux, x64, goat, epyc], step uses ∈ {actions/checkout@v6, voidzero-dev/setup-vp@v1, actions/upload-artifact@v4}. YAML 파서는 저장소 node_modules/.pnpm/yaml@2.*를 git show로 꺼낸 내용에 적용. 테스트: 기존 7개(허용 4, 거부 3) + hosted runs-on 거부 + reusable job 거부. 임시 git 저장소 + PATH 앞 mock gh로 훅을 sh -e 실행.

## gate

핸드오프의 source/GitHub/EPYC gate 그대로(ChatView 항목은 ef4748eb7로 충족, 헬퍼 대신 web tsc 0과 해당 effect가 존재하는 store API만 쓰는지로 확인).

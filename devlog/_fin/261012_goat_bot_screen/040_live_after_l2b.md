# 040 — L2b 머지 뒤 실제 연결 (wp4)

- #32가 dev에 머지되면 rebase. #32의 `channelEnvironment` atoms와 `goatBotIngestInput`으로 `GoatBotChannelPort`를 만들어 앱 루트에서 제공한다.
- 격리 dev 서버(`vp run dev`, 워크트리 .t3, 실행 중인 :3773/:3774는 건드리지 않음)에서 ensureBot → ingest → 사용자 말풍선과 접수 답 또는 실패 말풍선을 확인한다. 접수 provider가 없으면 failure 말풍선 경로로 확인한다.
- #32가 머지되지 않았으면 이 단계는 "L2b 대기"로 보고한다.
- 교체와 rebase 뒤 030의 fmt/lint, typecheck, 관련 테스트, build, 독립 리뷰를 다시 돌리고 PR을 갱신한다(--force-with-lease). 머지 관리 스레드에 다시 보고한다.

## 기록 (2026-10-12)

- #32가 dev에 c82962d4d로 머지됨. #56을 origin/dev 42bfc7e5c 위로 rebase하고 포트 공급 커밋을 같은 PR에 넣음(머지 관리 스레드에 알림).
- 격리 dev 서버(`vp run dev --home-dir /tmp/l3-goatbot-home`, 체크아웃 밖이라 Scratch 사용 가능): /bot → 서버 봇 스레드, 빈 화면 예시, 연속 두 입력의 말풍선·읽음 시각·접수 답(인용 포함), 칩 Done과 요약, 완료 보고 말풍선, Open thread → 작업자 코딩 화면, 서버 중지 → 연결 끊김 띠·입력창 비활성·칩 링크 "Can't reach the work computer". 작업자는 파일을 바꾸지 않음(git status 깨끗). :3773/:3774는 그대로.
- 관찰(서버, L2b에 전달): 작업을 만든 입력에 접수 답이 "도구를 실행할 수 없다"고 답함.
- 리뷰(Claude) PASS. 반영: 중단된 요청의 문구, fork delta 경로. 남김: 봇 입력 생성이 #32 `goatBotIngestInput`과 같은 모양의 로컬 사본(봇 참조 타입에 projectId가 없어서), operate 권한 없는 연결은 ensure 오류로 보임.
- 스크린샷은 로컬(`~/.goat/userdata/browser-artifacts/` mv4zasy9, mv4zbzpt, mv4zcljt). private 저장소라 외부 업로드를 하지 않았고, 미리보기 브라우저가 GitHub에 로그인돼 있지 않아 PR 첨부는 사람이 한다.

# euta-app

euta(End-User Test Automation) **Electron 데스크톱 앱**. 엔진(`@euta/core`)을 메인 프로세스에 내장해 YAML 테스트 스크립트를 실행·실시간 표시하고, 실행 이력과 리포트를 보여 주며, 터미널 패널에서 사용자가 설치한 `claude`/`codex` CLI 를 **수정 없이** 띄운다.

설계: `euta-workspace/40.설계/ADR_010`(앱 구성·빌드) · `ADR_011`(터미널 패널·AI 정책) · `ADR_012`(로컬 서버·라이브 스토어 계약) · `ADR_015`(AI 채팅) · `ADR_016`(프로젝트 저장소) · `SPEC_프로젝트-관리`.

## 준비

```bash
# 엔진을 먼저 빌드한다 (앱은 link:../euta-engine/packages/core 의 dist 를 쓴다 — ADR-001)
cd ../euta-engine && pnpm install && pnpm -r build && pnpm euta install-browsers

cd ../euta-app
pnpm install        # postinstall: Electron 바이너리 다운로드, node-pty spawn-helper 실행 권한 복구
pnpm build          # out/{main,preload,renderer}
pnpm start          # 빌드된 앱 실행 (electron-vite preview)
pnpm dev            # 개발 모드 (렌더러 HMR)
```

요구: Node ≥ 22.13, pnpm 9. Electron ^44.10.0(Node 24.22.1) — 네이티브 재빌드 없음(node:sqlite 내장, node-pty N-API prebuild).

## 개인 테스트용 패키징 (macOS)

```bash
pnpm package        # → release/dist/mac-arm64/euta.app  (ADR-014)
open release/dist/mac-arm64/euta.app
# 설치(Spotlight·Launchpad 에서 찾기): 앱을 끈 뒤 새 빌드마다 다시 복사
ditto release/dist/mac-arm64/euta.app /Applications/euta.app
```

- 엔진을 함께 빌드하고 스테이징 폴더에서 런타임 의존성만 담아 `.app` 을 만든다. **ad-hoc 서명 — 이 Mac 에서만 실행용**, 배포·공증 아님.
- Playwright 브라우저는 앱에 들어 있지 않다(사용자 캐시 사용). 없으면 엔진에서 `pnpm euta install-browsers`.
- 패키징된 앱으로 E2E: `EUTA_E2E_EXECUTABLE=$PWD/release/dist/mac-arm64/euta.app/Contents/MacOS/euta npx playwright test`
- `EUTA_PACKAGE_OUT=release/e2e pnpm package` — 출력 폴더를 바꾼다(`release/dist` 의 앱을 실행 중일 때 덮어쓰지 않고 패키징 E2E 를 돌릴 때).

## 프로젝트 (SPEC_프로젝트-관리 · ADR-016)

테스트 대상 사이트마다 **프로젝트**를 만든다. 프로젝트에는 환경(dev·staging·prod 의 주소·변수·secrets), 스크립트 라이브러리, 스위트, 실행 이력, AI 대화, 작업 로그가 함께 저장되고 앱을 껐다 켜도 그대로다.

```
<userData>/app.json                최근 프로젝트 순서 · 마지막 프로젝트 · AI 기본 모델
<userData>/vault.json              secret 암호문만 (Electron safeStorage — macOS 키체인 키)
<userData>/projects/<id>/
  project.json                     프로젝트 + 환경 + 스위트
  scripts/                         YAML 스크립트 (하위 폴더 허용)
  baselines/<envId>/               시각 비교 기준 이미지 (환경별)
  runs/ + runs/index.sqlite        실행 결과 (엔진 형식, run.json meta 에 프로젝트·환경)
  suite-runs/<id>.json             스위트 실행 결과
  chats/<id>.json                  AI 대화
  activity/<YYYY-MM>.jsonl         작업 로그 (append-only)
  recordings/<id>/                 시연 녹화: recording.json + shots/<seq>.png (가림 적용)
```

- macOS `<userData>` = `~/Library/Application Support/euta`. 이전 버전의 `settings.json`·`runs/`·`chats/` 는 읽지 않고 지우지도 않는다.
- 실행할 때 환경을 고르면 `BASE_URL`(환경 주소)·환경 변수·secrets 가 들어간다. 스크립트는 `target.baseUrl: ${env.BASE_URL}` 로 쓰면 환경만 바꿔 같은 스크립트를 돌린다.
- secret 은 쓰기 전용(설정·교체·삭제, 이름만 보임). OS 보안 저장소를 못 쓰는 환경(암호화 불가, Linux `basic_text`)이면 저장을 거부하고 경고한다 — 환경별 외부 secrets 파일을 대신 지정할 수 있다. 값은 화면·AI·로그·리포트로 가지 않는다.

## 화면

| 영역 | 내용 |
|---|---|
| 사이드바 | 프로젝트 목록(고정 → 최근), 실행 중 표시, 새 프로젝트, 앱 설정. 첫 실행이면 만들기 안내 |
| 스크립트 | 라이브러리 목록(이름·경로·최근 실행) · **보기**(상세: 단계 문장·최근 실행·편집·이력·AI 수정 요청) · 시연으로 만들기 · 새로 만들기 · 가져오기 · 이름 변경 · 삭제(삭제된 스크립트에서 복원) · 내보내기 · 검증 · 실행 · 기본 편집기로 열기. 바깥 변경 자동 반영 |
| Run | 스크립트 + 환경 → 검증 → 실행(vars·env 덮어쓰기, headless, 브라우저) · 스위트 실행/취소 |
| Live | 실행별 스텝 타임라인 · 스크린샷 · expect · 지표 · 콘솔/네트워크 실패. 앱·스위트·AI·외부 MCP 실행 |
| History | 프로젝트 실행 목록(환경 열, 스위트 묶음) → Open · Report · ↗ |
| AI | 프로젝트 채팅(작업 폴더 = 프로젝트 scripts/, 실행 환경 선택) · 고급: 터미널(`EUTA_RUNS_DIR` = 프로젝트 runs) |
| 작업 로그 | 실행·스위트·AI 대화·스크립트·설정 변경 타임라인, 종류·행위자 필터, 클릭 → 대상 |
| 프로젝트 설정 | 기본 정보 · 환경 · secrets · 기본 브라우저 · 스위트 · 삭제(이름 입력 확인) |
| 앱 설정 | 화면 테마(시스템·밝게·어둡게 — `nativeTheme`, ADR-034) · AI 기본 모델 · vault 상태 · 데이터 위치 |

## 스크립트 보기 · 편집 · 이력 (SPEC_스크립트-보기-편집 · ADR-018)

스크립트 탭에서 이름이나 **보기** 를 누르면 상세 화면이 열린다. YAML 을 몰라도 된다.

- **보기**: 단계마다 한국어 문장(예: "'이메일' 입력란에 🔒USER_EMAIL 입력", "'로그인' 버튼 클릭", "확인: 주소에 /dashboard 포함"). 스텝 이름은 굵은 제목, 공통 옵션은 배지, 묶음은 접고 펼친다. 상단 경고: 검증 오류 · 선택 환경에 없는 secret 이름 · CSS 로 고른(깨지기 쉬운) 대상 수.
- **최근 실행 겹치기**: 단계별 ✔/✖ · 시간 · 오류 · 🖼 스크린샷(눌러서 크게). 실행 당시 내용과 지금 내용이 같을 때만 그대로 보이고, 다르면 "수정 이후 아직 실행하지 않음" 과 함께 흐리게. [실행] 은 그 자리에서 돌리고 끝나면 다시 그린다.
- **편집**: 단계를 누르면 동작별 폼(대상 종류 + 값, 입력값은 일반/🔒secret 이름/변수/환경 변수, 확인 조건, 측정 항목, 공통 옵션, 스텝 이름). 추가(분류 메뉴) · 삭제 · 복제 · 순서(⠿ 끌기, ↑↓) · 묶음 넣기/빼기 · 스크립트 정보(이름·설명·대상 주소·기본값·녹화·브라우저·변수). 실시간 검증 — 오류가 있으면 **저장** 이 꺼진다. 저장은 바뀐 단계만 다시 쓰고 나머지 주석·순서는 그대로 둔다. 저장하지 않고 떠나면 확인을 묻는다.
- **이력**: 저장 · AI 수정 · 녹화 저장 · 바깥 변경 · 되돌리기 · 이름 변경 · 삭제마다 버전이 남는다(스크립트당 100개, 이름을 바꿔도 이어짐). 버전을 고르면 단계 문장 비교(추가 초록 · 삭제 빨강 · 변경 전후) → **이 버전으로 되돌리기**. 저장 위치: `projects/<id>/script-history/`.
- **AI에게 수정 요청**: 상단 버튼(스크립트 전체) 또는 단계의 "AI에게" → 요청을 쓰면 새 AI 대화가 열린다(스크립트 경로·단계 번호와 문장·선택 환경을 함께 보냄). AI 가 저장하면 상세 화면에 "AI 가 수정함 — 변경 보기" 배너.
- 편집 중 파일이 바깥(다른 편집기·AI)에서 바뀌면 알림: "다시 불러오기"(내 변경 버림) 또는 "내 것으로 저장"(바깥 변경은 이력에 남음). 앱 안 YAML 텍스트 편집기는 없다 — 필요하면 "기본 편집기로 열기".
- 작업 로그: `script.changed`(행위자·요약) · `script.restored`.

## 시연으로 스크립트 만들기 (SPEC_스크립트-작성-시연녹화 · ADR-017)

YAML 을 직접 쓰지 않는다. **스크립트 탭** 또는 **AI 탭**의 "● 시연으로 만들기" → 환경·시작 경로·녹화 이름 → 브라우저가 열리면 사이트를 평소처럼 사용한다.

- 오른쪽 녹화 패널: 동작이 실시간으로 쌓인다. 메모(Enter, 예: "여기서 로그인", "합계가 1,200원이어야 함"), **✓ 확인**(체크포인트 — 종류: 보임·숨김·텍스트 같음·텍스트 포함·현재 주소·개수; 켜면 다음 클릭은 실행되지 않고 검증 대상이 된다), 일시정지/재개, 마지막 동작 취소, 줄마다 민감 표시·메모·삭제, 종료.
- 비밀번호·자격증명 입력란의 값은 **페이지 안에서 버려** 앱에 오지 않는다. 다른 입력란도 "민감" 을 누르면 값이 지워지고 그 화면의 스크린샷도 지워진다. 초안에는 `${secrets.NAME}` 으로 들어가며, 환경에 같은 뜻의 이름(예: `USER_PASSWORD`)이 있으면 그 이름을 쓴다.
- 종료 후 **AI 없이 저장**: 기계적 초안을 라이브러리에 저장(등록 필요 secret 표시). **AI로 정리**: 새 AI 대화에 녹화를 붙여 보낸다 — AI 가 `get_recording` 으로 보고 다듬어 저장·검증·실행(실패 시 최대 3회 수정)하고 결과를 보고한다. 이후 수정은 대화로.
- 녹화는 프로젝트에 남는다(스크립트 탭 아래 목록: 초안 저장 · AI로 정리 · 이름 변경 · 삭제). 작업 로그: `recording.started` · `recording.finished` · `recording.converted`.
- 범위: 한 탭. 팝업·새 탭·iframe 안 동작은 "녹화 안 됨" 으로만 표시된다. 음성 설명·녹화 재생은 없다.
- 시연 없이 **말로 시키기**: AI 탭 입력창 위 예시("로그인해서 보고서를 PDF로 내보내기 테스트 만들어줘")처럼 목표만 말하면 AI 가 headed 세션으로 직접 돌아본다.

## TC 문서로 만들기 (SPEC_TC-문서-변환 · ADR-039)

QA 가 쓰는 자연어 TC 문서(절차 · 기대 결과)를 가져와 TC 마다 스크립트로 바꾸고, 거꾸로 스크립트를 TC 문서로 내보낸다.

- **가져오기**: 스크립트 탭 "TC 문서로 만들기" → xlsx · csv · docx · md → 미리보기(TC 목록 · 단계 표 고치기 · 사전 조건 묶음 · 경고) → 확정. 원본 파일은 저장하지 않는다. 양식을 못 알아보면 [AI로 읽기](새 AI 대화가 `get_tc_import` 로 표를 읽고 `save_tc_extraction` 으로 제출).
- **저장**: `projects/<id>/tc-docs/<docId>/tc-doc.json` — 정리된 TC · 사전 조건 묶음 · TC 별 변환 상태 · 변환 대기열. 클라우드 프로젝트도 이 PC 에만.
- **변환**: 스크립트 탭 위쪽 **TC 문서** → 문서 → 검색 + 체크(체크 순서 = 대기열) → [AI로 변환](한 채팅에서 하나씩: 사전 조건 스크립트 먼저, 화면 확인, 저장 → 검증 → 실행 → `set_tc_conversion`). 멈추면 대기열이 남아 [이어서 변환]. 안 되는 TC 는 [시연으로 변환](녹화 패널 위 TC 단계 안내 · [다음 단계] → 단계별 묶음 초안) · [다시 변환].
- **테스트 세트 만들기**: 문서 전체 · 분류별 · 체크한 TC, 사전 조건 스크립트를 맨 앞에. **내보내기**: TC 문서 · 테스트 세트 · 체크한 스크립트 → xlsx(블록형, 다시 가져오기 가능) · md.
- 결과 화면은 `manual` 단계를 **"수동 확인 필요"** 로 보인다(실시간 · 실행 이력 · 스크립트 상세 · 세트 리포트). 작업 로그: `tcdoc.imported` · `tcdoc.converted` · `tcdoc.exported` · `tcdoc.deleted`.

## euta cloud 동기화 (SPEC_클라우드-앱-연동 · ADR-025)

- 앱 설정 → 클라우드: 서버 주소 → 로그인(장치 인가 — 화면의 코드를 브라우저에서 승인). 토큰은 `cloud/account.json` 에 safeStorage 암호문으로만 둔다. 사이드바 하단 칩 = 연결됨 · 오프라인(재시도 중) · 로그인 필요.
- 사이드바 "클라우드에서 받기" → 내 프로젝트 / 조직 공개 → [받기] = 작업 사본(`cloud/<serverId>/projects/<cloud projectId>/`), 이미 받았으면 [열기], 보기면 [권한 요청](실행자·편집자 + 메모). 화면은 서버 `can` 으로: 보기 → "보기 전용"(편집·실행 숨김), 실행자 → "실행 전용"(실행만). 내보내지거나 구성원만으로 바뀌면 "접근 권한 없음"(이 PC 실행 기록만, [이 PC 에서 지우기]).
- 스크립트 저장(편집기·AI·녹화·가져오기·바깥 편집기)은 작업 사본에 쓰고 기준 버전과 함께 서버로 보낸다. 오프라인이면 "보내기 대기"로 쌓였다가 다시 연결되면 순서대로 보낸다. 충돌이면 충돌 화면(① 내 것으로 새 버전 ② 서버 것 받기 ③ 내 것을 사본으로). 이력·비교·되돌리기는 서버 이력.
- 테스트 계정: 서버는 값을 돌려주지 않으므로 이 PC 실행용 값은 이 PC vault 에 따로 넣는다("클라우드: 등록됨/없음 · 이 PC: 등록됨/없음"). "클라우드에도" 를 고르면 같은 값을 서버에도 저장(편집자 이상).
- 로컬 프로젝트 → 프로젝트 설정 → "클라우드로 올리기" = **전환**: 설정·환경·스크립트·테스트 세트를 올리고(테스트 계정 값 제외) 이 PC 의 실행 기록·대화·녹화·작업 로그·이 PC 값을 작업 사본으로 옮겨, 사이드바에 그 프로젝트 하나만 남는다. 예전에 복사로 올린 프로젝트는 위쪽 [클라우드 프로젝트와 합치기](대상 고정, 다른 스크립트만 고르기).

## 클라우드 실행 위임 · 예약 · 앱 알림 (SPEC_클라우드-앱-연동 C3 · ADR-026)

- Run 탭 "실행 위치: 이 PC / ☁ 클라우드"(스크립트 목록 "☁ 실행" 도 같은 화면). 클라우드는 버튼 옆에 사전 검사 사유(먼저 보내기 · OS 입력 · secrets 규칙 · 클라우드 테스트 계정 · 사설 주소 · 하루 실행 상한)를 보인다. 진행은 Live 에 "클라우드" 배지로, 앱을 꺼도 서버에서 계속된다(취소 가능).
- History = 로컬 + 클라우드 실행(출처 · 실행 위치 열). 클라우드 실행 "Open" 은 결과 파일을 작업 사본 `cloud-runs/<id>/` 로 받아(2GB, 오래 안 연 것부터 지움) 지금의 재생·리포트로 본다. 보관 기간이 지나면 "파일 만료"(요약만). 로컬 실행은 "☁ 클라우드에 올리기"(버전 연결 / 로컬 수정본).
- 예약 탭: 목록·다음 실행·경고·추가/편집/켜기·끄기/삭제(편집자 이상). 앱이 꺼져 있어도 서버가 돌린다.
- 앱 알림: 앱 설정 → 클라우드 "앱 알림"(기본 켬) — 예약 실행 실패·회복, 내가 요청한 클라우드 실행 종료를 OS 알림으로. 꺼져 있던 동안의 알림은 다음 시작 때(여러 건이면 1건으로 접음).

## secrets 규칙 (모든 로컬 실행 — SPEC_프로젝트-관리)

- `${secrets.*}` 는 `fill` 값 · `type` 텍스트에만 — 주소·변수·확인 등에 쓰면 실행 전 검증 오류. secrets 입력 스텝은 페이지 호스트가 환경의 **허용 도메인**(프로젝트 설정 → 환경, 기본 = 주소 호스트)일 때만 실행. 실행 버튼·스위트·AI 채팅·고급 터미널의 MCP 서버(`EUTA_RESTRICT_SECRETS`·`EUTA_ALLOWED_DOMAINS`) 모두 같다. 클라우드 전용 규칙(`input: os` 거절·녹화 기본값)은 로컬에 없다.

## AI 채팅 (ADR-015)

- **본인 PC · 본인 Claude 구독 · 본인 사용 전용.** Electron 메인에서 Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)가 SDK 에 들어 있는 Claude Code CLI 를 띄우고, 이 Mac 의 기존 Claude Code 로그인을 그대로 쓴다.
- 로그인 상태는 공식 `claude auth status --json`, 로그인·로그아웃은 `claude auth login` / `claude auth logout` 실행으로만 한다. 앱은 자격증명 파일·키체인·토큰을 읽지 않고 인증 환경변수를 설정하지 않는다. `ANTHROPIC_API_KEY` 등이 설정돼 있으면 이름만 경고한다.
- AI 가 쓸 수 있는 도구는 euta 도구뿐(MCP 서버와 같은 도구 + 작업 폴더 안 `list_files`/`read_file`/`save_script`). 셸·파일 편집·웹 도구는 꺼져 있고, 모든 호출은 deny-by-default 게이트를 거친다. 결과는 SecretGuard 로 마스킹된다.
- AI 가 시작한 실행은 Live/History 에 `AI` 로 바로 보인다. 세션(session_open)은 기본 headed.
- 대화는 프로젝트의 `chats/*.json` 에 저장된다(스크린샷 제외). 채팅 상단의 환경이 AI 의 `run_script`·`session_open` 주소·변수·secrets 가 된다. 이어서 묻기는 SDK 세션 resume — CLI 가 자기 대화 기록을 `~/.claude/projects/` 에 남긴다.
- 테스트는 모델을 부르지 않는다: 도구 계층은 픽스처 사이트로, 인증은 가짜 `claude` 스크립트로, 대화는 가짜 query 생성기(`EUTA_E2E_FAKE_AGENT=1`, E2E 전용)로 검증한다.

## Claude Code / Codex 연결 (고급: 터미널)

앱 터미널에서 띄운 CLI 는 사용자 환경을 그대로 물려받고, 앱은 다음 다섯 변수만 추가한다: `EUTA_APP_URL` · `EUTA_APP_TOKEN` · `EUTA_APP_EVENTS_URL` · `EUTA_APP_EVENTS_TOKEN` · `EUTA_RUNS_DIR`. 로그인은 CLI 안에서 사용자가 직접 한다 — 앱은 자격증명·설정 파일·키체인·토큰을 읽거나 저장하지 않고, 인증 관련 환경변수를 설정하지 않는다.

```bash
# 권장: euta 플러그인 (MCP + skills + 활동 hooks)
claude plugin marketplace add /abs/path/euta-claude-plugin
claude plugin install euta@euta-tools

# MCP 만 (활동 패널 없음, 실행 이벤트는 Live 로 전달됨)
claude mcp add euta -e EUTA_RUNS_DIR=<프로젝트 runs 폴더> -- node /abs/path/euta-engine/packages/mcp-server/dist/index.js
codex mcp add euta --env EUTA_RUNS_DIR=<프로젝트 runs 폴더> -- node /abs/path/euta-engine/packages/mcp-server/dist/index.js
```

## 로컬 서버 계약 (요약, 정본은 ADR-012)

- `127.0.0.1` · 임의 포트 · 실행마다 새 토큰(32바이트 hex). 모든 요청: loopback 원격 주소(아니면 403) → loopback `Host`(403) → `Authorization: Bearer <token>`(401) → `POST` 만(405) → `Content-Type: application/json`(415) → 4 MiB 한도(413) → JSON(400). CORS 헤더 없음.
- `POST /events` — `{source, protocol: 1, pid?, sentAt?, events: [...]}` → `204`. runId 별로 Live 에 반영(중복·순서 뒤바뀜 허용, 빈 seq 는 `runDir/steps.jsonl` 로 복구).
- `POST /hooks/claude` — Claude Code hook 입력 JSON 그대로 → 먼저 `204`(본문 없음 = 결정 없음), 그다음 기록. 도구 호출은 `session_id + tool_use_id`, 서브에이전트는 `agent_id` 로 짝지음(비동기 hook 의 순서 뒤바뀜 대응).

## 검증

```bash
pnpm typecheck      # main/preload/shared + renderer
pnpm test           # vitest — 프로젝트 저장소·vault·작업 로그·실행 조립·라이브러리·스위트(픽스처 사이트)·로컬 서버·라이브 스토어·hook·pty env·AI 도구/채팅
pnpm test:e2e       # 빌드 후 Playwright _electron — 프로젝트 생성→환경·secrets→실행→스위트→재시작 유지→AI 채팅→삭제, userData 평문 secret 검사 (mock keychain)
                    #   + e2e/recording.spec.ts: 시연으로 만들기→녹화 브라우저 조작·메모·체크포인트→AI 없이 저장→실행→AI로 정리(테스트 에이전트)
                    #   + e2e/script-edit.spec.ts: 상세(단계 문장·실행 겹치기·스크린샷)→폼 편집→잘못된 값 저장 불가→저장→실행→이력 비교→되돌리기
                    #     →AI에게 수정 요청(테스트 에이전트)→배너·이력 ai→편집 중 바깥 변경 알림→재시작 후 이력 유지
                    #   + e2e/cloud.spec.ts: 실제 로컬 euta cloud 서버(../euta-cloud docker compose DB + 빌드된 서버, 새 DB)로
                    #     장치 로그인→올리기→두 번째 계정(보기→편집자)→충돌 3선택→오프라인 대기·재전송→바깥 변경→AI 저장 충돌→평문 검사
                    #     (euta-cloud 서버가 빌드돼 있고 docker 가 떠 있어야 함 — 없으면 건너뜀)
                    #   + e2e/cloud-runs.spec.ts: 실제 서버(RUNNER_TOKEN, 개발 전용 ALLOW_PRIVATE_TARGETS=true) + 실제 러너 프로세스로
                    #     로컬 secrets 규칙(URL secret·허용 밖 호스트)→클라우드 실행(사전 검사·Live)→앱 알림·클릭→예약→앱 종료 중 회차 실행
                    #     →재기동 History·열기(내려받기·재생)→로컬 실행 올리기 (euta-cloud runner 빌드 필요)
                    #   + e2e/one-project.spec.ts: 가짜 클라우드(e2e/fake-cloud.ts, 서버 불필요)로 계정 A·B — 올리기=전환(사이드바 하나·실행 기록 이관)
                    #     →받기(조직 공개·두 번 받기 없음)→남의 프로젝트에 붙이기 거절→권한 요청→승인→실행 전용→접근 권한 없음 잠금→합치기(고르기·같은 내용)
                    #   + e2e/tc-docs.spec.ts: TC 문서로 만들기→미리보기 고치기→확정→검색+체크 순번→AI로 변환(테스트 에이전트)→2개 후 멈춤
                    #     →재시작→이어서 변환→분류별 테스트 세트→세트 실행(수동 확인 필요)→xlsx 내보내기·다시 읽기→시연으로 변환(TC 단계 안내)
pnpm verify         # 위 셋
```

E2E 는 앱을 띄워 엔진 예제 `widgets.yaml` 을 UI 로 실행 → Live 타임라인 passed → History 등록 → 합성 이벤트 배치·hook POST 렌더 → 터미널에서 셸 명령 출력까지 확인한다. `claude`/`codex` 는 테스트에서 띄우지 않는다. 테스트 전용 훅은 `EUTA_E2E=1` 일 때만 main 의 `globalThis.__eutaTest` 에 생긴다(렌더러에는 노출되지 않음). 녹화 E2E 는 `__eutaTest.recorderPage()`(녹화기의 Playwright Page)로 녹화 브라우저 안에서 "사람" 역할을 한다 — 디버그 포트·CDP 없이(ADR-017).

## 알려진 한계

- 패키징(dmg/exe, 서명, asar unpack — playwright·node-pty)은 아직 없다. `pnpm start` 는 빌드된 소스 트리를 실행한다.
- Windows 는 코드상 고려(PATHEXT·`.cmd` shim 실행·ConPTY·PowerShell 기본 셸)만 했고 검증하지 않았다.
- 실행 중단(취소) 버튼 없음 — core 에 중단 API 가 없다(ADR-008 공백과 같음).

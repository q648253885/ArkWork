# ArkWork

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | **한국어**

> 로컬 우선 AI Agent 워크벤치 — ReAct 추론 루프를 **보이고, 제어하고, 재사용**할 수 있게 만듭니다.

![License](https://img.shields.io/badge/license-Apache%202.0-blue) ![Electron](https://img.shields.io/badge/Electron-33-47848F) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

![ArkWork 워크벤치 — 실시간 ReAct 단계 스트림, ask_user 단계 게이트, 플랜 리스트](docs/screenshots/workbench-react-task.png)

대부분의 AI 제품에서 Agent의 추론은 블랙박스입니다. 디버그할 수도 없고, 중간에 개입할 수도 없으며, 컨텍스트를 제어할 수도 없습니다. ArkWork는 ReAct 루프를 일급 객체로 만들어 관찰·조종·재사용할 수 있게 합니다 — 모든 데이터는 사용자의 컴퓨터 안에만 머무릅니다. 클라우드도, 텔레메트리도 없습니다. 대화·기억·인덱스는 워크스페이스의 평범한 파일로 저장되며, 모델 호출은 사용자가 설정한 API 키로 직접 이루어집니다.

**[다운로드](https://github.com/q648253885/ArkWork/releases)** 페이지에서 미리 빌드된 설치 프로그램(macOS Apple Silicon / Intel, Windows, Linux)을 받거나, 아래 안내에 따라 소스에서 빌드하세요.

## 공식 웹사이트

**[→ www.hellowl.com](https://www.hellowl.com/)** 은 ArkWork의 공식 제품 웹사이트입니다. 실제 앱 스크린샷(ReAct 작업 보기, 도움말 센터, 설정 및 다국어)으로 워크벤치를 소개하고, 4계층 메모리와 **클라우드 없음 · 텔레메트리 없음 · 순수 파일** 설계를 설명하며, macOS / Windows / Linux 세 플랫폼의 다운로드 링크를 제공합니다. 위 링크를 클릭하면 GitHub에서 공식 사이트로 바로 이동합니다.

## 핵심 기능

### 1. 보이는 ReAct 엔진

모든 작업은 Reason → Act → Observation 루프를 완전히 streams 전송·영구 저장하며 실행합니다.

- **실시간 단계 타임라인** — Reason / Act / Observation을 색으로 구분하고, 반복 번호·소요 시간·토큰 사용량을 표시합니다. 한 턴 내 다중 도구 호출은 병렬 실행되며 각각이 독립된 단계로 기록됩니다.
- **언제든 개입** — 어느 순간이든 Pause / Resume / Cancel(`Esc`). 확인이 필요한 지점에서는 엔진이 `ask_user` 게이트로 멈추고 클릭 가능한 선택지를 제시합니다. 확정 후 중단 지점부터 계속됩니다.
- **컨텍스트는 사용자의 것** — L1 작업 기억의 각 항목을 체크하여 다음 턴의 컨텍스트에 포함할지 결정합니다. Context 패널이 소스별 주입 비중을 시각화합니다.
- **안전 장치 내장** — doom-loop 감지, 도구 호출의 서명/카테고리별 예산, 반복 상한 도달 시 하드 실패 대신 우아한 일시정지, 토큰 임계치 초과 시 자동 압축.
- **Checkpoint** — 매 턴마다 자동 저장되어, 임의의 턴으로 되돌리고 그 지점부터 재실행할 수 있습니다.

### 2. 4계층 기억 시스템

기억은 `<workspace>/.arkwork/` 하위의 평범한 파일로 영구 저장됩니다 — **데이터베이스도, embedding 서비스도 없습니다**. 검색은 로컬 전체 텍스트 검색(MiniSearch)을 사용하므로 시스템 전체가 오프라인에서 동작합니다.

| 계층 | 보관 내용 | 동작 |
|------|----------|------|
| **L1 작업 기억** | 단일 작업의 대화·추론·도구 observation | 체크 / 편집 / 보관 가능. 토큰 임계치에서 자동 압축 |
| **L2 파일 기억** | 작업 산출물과 대용량 도구 결과 | 작업 디렉터리에 기록되며 단계에서 참조 |
| **L3 큐레이션** | `memory.md` + `user.md` 노트 | "기억해 둬…"는 일단 pending 영역에 들어가고 다음 실행에서 병합. 초과 시 LLM이 손실 병합 |
| **L3 아카이브** | 완료된 모든 작업의 전체 L1 | 불변, 세션 간 전체 텍스트 검색 가능 |
| **L4 사용자 프로필** | 선호·교정·스타일 관찰 | LLM이 ≤500 tokens 프로필을 합성. 10개 버전을 보존하며 롤백 가능 |

증류 파이프라인이 L1 항목을 재사용 가능한 사실·스킬·지식베이스 항목으로 변환합니다 — 경험은 사라지지 않고 축적됩니다.

### 3. Coding 에이전트(`@coder`)

실제 소프트웨어 작업을 위해 조정된 내장 에이전트. 다른 에이전트와 동일한 도구 세트를 사용합니다.

- **문서 중심 개발** — always-on 코어 스킬이 PRD → spec → plan → 단계별 구현을 추진하며, **단계 게이트**가 다음 단계 시작 전에 `ask_user`로 사용자 확인을 받도록 강제합니다.
- **엔지니어링 스킬 번들** — `spec`, `plan`, `bugfix`(`bugfix`는 전용 loop runner 동봉).
- **풀 도구 세트** — 파일 읽기·쓰기·편집, glob & grep 검색, shell(4단계 명령 위험 평가 + 감사 로그), 웹 검색, URL 페치, 브라우저 자동화, 서브에이전트 위임.
- **5단계 권한 모드**(`Shift+Tab`) — default / auto-approve / accept-edits / plan / bypass. 위험한 도구는 정교한 인앱 레이어에서 확인을 요청하며, 승인은 세션 단위로 기억됩니다.

![설정-고급: 권한 모드, allow 규칙, 기억 압축 튜닝](docs/screenshots/settings-advanced-permissions.png)

### 4. 지식 베이스

- **PDF / DOCX / TXT / Markdown** 임포트. 문서는 단락 경계로 청크화(약 500 tokens + 오버랩)되어 로컬에서 인덱싱됩니다.
- 지식 베이스는 **작업 단위로 활성화**. 실행 시작 시에도 자동 회상 주입을 수행합니다.
- 에이전트는 `kb-search` 스킬로 능동적으로 검색 가능. **벡터 DB 불필요**.

### 5. 스킬과 마켓플레이스

- 내장 도구·MCP 도구·지시형 스킬(`skill.json` + `SKILL.md`)을 하나의 추상화로 통합.
- 지시 모드: **always-on**(시스템 프롬프트 주입), **on-demand**(호출 시 로드, 지속 유효), **hint-only**. 스킬은 게이트를 선언할 수 있음.
- 계층적 탐색 — project > user > bundled > runtime — 가까운 층이 아래를 가립니다. `SKILL.md`는 호출 시에만 필요한 만큼 로드(점진적 노출).
- **마켓플레이스**: 커뮤니티 스킬 검색 및 원클릭 설치, 즐겨찾기·검색 기록 지원.

### 6. MCP 지원

자작 무의존 JSON-RPC 2.0 클라이언트, **stdio 전송**: 다중 서버 동시 관리, `tools/list`로 도구를 발견하여 런타임 스킬로 주입(연결 해제 시 자동 제거), 하트비트 및 자동 재연결 구현.

### 7. 내장 브라우저

다중 탭 브라우저가 Inspector 도크에 상주하며 에이전트가 자율 조종할 수 있습니다.

- `snapshot`이 안정적인 `ref=e<N>` 번호의 인터랙티브 요소 트리를 출력. click / type / select / press / scroll은 ref 우선으로 위치를 지정합니다.
- console 로그를 캡처. 스크린샷은 저장되어 멀티모달 모델에 전달됩니다.
- **인간-에이전트 코파일럿**: 사용자가 페이지를 클릭하면 인간이 주도권을 잡고, 에이전트는 마우스를 빼앗지 않고 명시적인 에러를 받습니다.

### 8. 모든 LLM 프로바이더

- 프로바이더 종류: `openai` / `anthropic` / `ollama` / `vllm` — OpenAI 어댑터는 모든 호환 엔드포인트(DeepSeek, Moonshot, Qwen, 로컬 서버 등)까지 커버합니다.
- Anthropic 어댑터는 Claude Code 스타일의 prompt caching(≤4 브레이크포인트)과 extended thinking 스트리밍을 구현. reasoning content와 캐시 적중 통계가 시각화됩니다.
- 모델별 능력 플래그 선언, 연결성 테스트 내장, Composer 하단의 칩에서 즉시 전환.

### 9. 자동화

cron으로 스케줄된 작업은 정시에 완전한 에이전트 플로우를 실행합니다. 같은 분 내 중복 제거, 시작 시 catch-up tick 지원, 모두 로컬에 영구 저장됩니다.

### 10. 채팅 박스가 아니라 워크벤치

- 3분할 레이아웃 + IntelliJ 스타일 Inspector 도크: Todos / Context / Files / Terminal / Logs / Browser(`⌥1~6` 전환).
- 플랜 리스트와 단계 타임라인은 **양방향으로 스크롤 동기화** — 리스트 항목을 클릭하면 그것을 생성한 도구 단계로 점프합니다.
- Quick Action `⌘K`(작업 / 파일 / 에이전트 / 명령 검색), QuickOpen `⌘P`, 플로팅 Preview `⌘E`(Markdown, 코드, 이미지, SVG, 표, 브라우저).
- 다크 / 라이트 테마, UI는 **简体中文 · English · 日本語 · 한국어** 지원, 워크스페이스 스위처, 실행 작업 수 / 기억 점유율 / 활성 모델을 표시하는 상태 바.

![설정-외관: 다크 / 라이트 테마와 4개 언어 UI](docs/screenshots/settings-appearance-i18n.png)

![도움말 센터: 완전한 키보드 단축키 표](docs/screenshots/help-center-shortcuts.png)

## 기술 스택

| 레이어 | 선택 |
|--------|------|
| 런타임 | Electron 33 + Node.js(ESM) |
| 빌드 | electron-vite 2.3 + Vite 5 + electron-builder 26 |
| 프론트엔드 | React 18.3 + TypeScript 5.6 + Tailwind CSS 3.4 + Zustand 5 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` |
| 검색 | MiniSearch(로컬 전체 텍스트, 벡터 DB 불필요) |
| 영구 저장 | 파일 시스템(JSON / JSONL) — 데이터베이스 없음 |

## 빠른 시작

요구 사항: Node.js ≥ 18, npm.

```bash
git clone https://github.com/q648253885/ArkWork.git
cd ArkWork/app
npm install
npm run dev
```

개발 모드에서 메인 프로세스는 `.dev-data/`를 userData로 사용하고, Vite dev server는 `http://localhost:5174/`를 리슨하며 Electron 창이 자동으로 열립니다.

설치 프로그램 빌드:

```bash
npm run build:mac    # macOS dmg + zip(Apple Silicon arm64 + Intel x64) → app/release/
npm run build:win    # Windows NSIS 설치 프로그램(x64)
```

### 모델 설정

최초 실행 시 **설정 → 모델**(`⌘,`)을 엽니다:

1. 「모델 추가」 클릭
2. id / name / kind(`openai` / `anthropic` / `ollama` / `vllm`) / baseURL / apiKey 입력
3. 「테스트」 클릭하여 연결 확인
4. 저장 후 Composer 하단의 모델 칩에서 언제든 전환

## 문서

| 언어 | 사용자 가이드 |
|------|----------|
| 简体中文 | [docs/user-guide.zh-CN.md](./docs/user-guide.zh-CN.md) |
| English | [docs/user-guide.en.md](./docs/user-guide.en.md) |
| 日本語 | [docs/user-guide.ja.md](./docs/user-guide.ja.md) |
| 한국어 | [docs/user-guide.ko.md](./docs/user-guide.ko.md) |

설치, 모델 설정, 핵심 개념(워크스페이스 / 작업 / 에이전트 / 스킬 / 기억 / 지식 베이스), 일상 워크플로, 키보드 단축키, FAQ, 트러블슈팅을 다룹니다.

## 디렉터리 구조

```
ArkWork/
├── app/                        # Electron 애플리케이션
│   ├── src/
│   │   ├── main/               # 메인 프로세스(agent engine / memory / kb / automation /
│   │   │                       #   mcp / checkpoint / ipc / llm / store /
│   │   │                       #   fs / browser …)
│   │   ├── preload/            # Preload 브리지(contextBridge)
│   │   ├── renderer/           # 렌더러 프로세스(React UI, i18n 4 로케일)
│   │   ├── shared/             # 공유 타입과 유틸리티
│   │   └── test/               # 테스트 인프라(electron 스텁 loader)
│   ├── scripts/                # 통합 테스트 러너 + i18n 도구
│   └── build-resources/        # 아이콘과 패키징 리소스
├── docs/                       # 사용자 문서 + 스크린샷
└── README.md
```

## 키보드 단축키

| 키 | 동작 |
|----|------|
| `⌘K` | Quick Action(검색 / 명령 / `>` `@` `#`) |
| `⌘P` | 빠른 파일 열기 |
| `⌘B` | 사이드바 토글 |
| `⌘,` | 설정 |
| `⌘1~6` | 에이전트 / 스킬 / 지식 / 기억 / 자동화 / 설정 |
| `⌥1~6` | Inspector: Todos / Context / Files / Terminal / Logs / Browser |
| `⌘E` | Preview 창 |
| `Shift+Tab` | 권한 모드 순환 |
| `Esc` | 오버레이 닫기 / 실행 중인 작업 일시정지 또는 정지 |

전체 표는 인앱 도움말 센터(`⌘/`)에서 볼 수 있습니다.

## 테스트

```bash
cd app
npm test            # 통합 러너: src/**/__tests__/*.test.ts(x) 자동 발견
npm run typecheck   # node와 web 두 tsconfig로 tsc 검증
```

## 라이선스

[Apache License 2.0](./LICENSE)
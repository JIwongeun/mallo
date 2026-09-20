# codex_system

Astra가 계획·검토하고 GPT-5.6 Sol이 구현하는 개인용 Codex 오케스트레이션 허브입니다. 프로젝트별 실행·검증 기록은 해당 프로젝트의 `.codex-system/`에, 근거가 확인된 재사용 패턴은 허브의 Brain에 보관합니다.

## 설치

Node 24 이상, pnpm, 로그인되고 정상 설정된 Codex가 필요합니다.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run doctor
pnpm run install:integration
node src/cli.mjs register --project C:\path\to\project
```

설치 후 Codex 앱에서 `Codex System` SessionStart 훅의 신뢰 상태를 확인하고 새 작업을 엽니다. 프로젝트는 이 저장소의 `workspace/` 아래에 두거나 외부 경로를 등록할 수 있습니다. `workspace/`, `brain/`, `.local/`, 프로젝트의 `.codex-system/`은 각 Git 기록에서 제외합니다.

## 사용

등록된 프로젝트를 Codex의 주 폴더로 열고 평소처럼 요청합니다. 허브를 보조 폴더로 함께 열어도 주 프로젝트만 대상으로 삼습니다. 범위 훅은 등록된 폴더에서만 컨텍스트를 추가하고, `codex-system:codex-system` 스킬과 MCP 브리지가 실행·질문·취소·진행 상태를 중계합니다. 진입을 진단할 때만 스킬을 명시적으로 선택합니다.

구현에는 프로젝트 루트의 `.codex-system-checks.json`이 필요합니다. 검사가 없거나 현재 Codex 권한이 쓰기를 허용하지 않으면 변경 전에 `blocked`로 끝납니다.

```json
{"checks":[{"id":"unit","argv":["node","--test"],"timeout_ms":60000}]}
```

CLI 진단과 복구는 다음 명령을 사용합니다. `resume --file`은 질문 답변이나 요구사항 변경으로 새 요청 문장이 필요한 경우에 사용합니다. 변경 시작 이후 결과가 불명확한 실행은 자동 재생하지 않습니다.

```powershell
node src/cli.mjs run --request-file C:\path\to\request.json
node src/cli.mjs status --run-id run-...
node src/cli.mjs cancel --run-id run-...
node src/cli.mjs resume --run-id run-... --file C:\path\to\revised-request.json
node src/cli.mjs skills inspect --project C:\path\to\project --stage implementation --file C:\path\to\task.json
node src/cli.mjs backup export --destination C:\path\to\backup
node src/cli.mjs backup import --source C:\path\to\backup --project-map C:\path\to\project-map.json
```

스킬은 매 단계 현재 Codex 인벤토리에서 다시 발견하며 작업 키워드·단계·충돌·명시 전용 정책으로 최대 2개를 선택합니다. 선언된 도구 의존성을 확인하고, 스킬·설정·훅이 바뀌면 이전 작업 문맥을 재사용하지 않습니다. 외부 스킬을 추가·변경·삭제한 뒤에는 새 Codex 작업을 열고 `skills inspect`로 선택 이유와 소스 해시를 확인합니다. 이 프레임워크는 외부 스킬을 자동 설치하거나 복구하지 않습니다.

Brain은 완료된 실행의 기준·검사·검토 근거가 있는 후보만 저장합니다. 한 번의 관찰은 provisional이며, 실패도 해당 조건과 실패 기준에만 적용됩니다. 검색은 현재 프로젝트와 공유 패턴을 FTS5로 찾고 적용 조건을 다시 확인해 최대 3개 카드만 다음 단계에 전달합니다.

Sol 수리는 실행당 최대 2회, Astra 재계획은 최대 1회입니다. 제거 명령은 소유권과 소스·캐시 해시가 그대로인 브리지만 제거하며 Brain, 프로젝트 등록, 작업 폴더는 보존합니다.

## 현재 상태와 제한

- 다음 개선판 **Relay**의 R0–R8 구현 계획은 [구현 계획서](docs/IMPLEMENTATION_PLAN.md)에 정리되어 있습니다. 폴더 자동 연결, 독립적인 Knowledge, 설치본과 개발 소스 분리, Git 기반 업데이트·롤백은 아직 구현 전이며 아래 사용법은 현재 설치본 기준입니다.
- 2026-09-20 기준 M0–M7, 41개 검사, 실제 데스크톱의 하위 폴더 단독·허브 보조 연결, 깨끗한 소스 환경의 구현·검사를 통과했습니다.
- 선택은 메타데이터·키워드 기반이며 모든 요청의 의미를 완벽하게 판별하지는 않습니다. 스킬 전달과 실제 사용·효과는 구분해서 기록합니다.
- 자연어 진입은 네이티브 훅·스킬 선택을 사용하므로 이미 열려 있던 작업에는 새 설치 상태가 반영되지 않을 수 있습니다.
- 모델은 `gpt-6-astra`와 `gpt-5.6-sol`, effort는 medium/high/xhigh만 사용합니다.
- Jev, 임베딩, 다중 사용자 서비스, Obsidian 연동은 v1 범위 밖입니다.
- 세부 게이트와 현재 증거는 [구현 계획](docs/IMPLEMENTATION_PLAN.md)에 기록합니다.

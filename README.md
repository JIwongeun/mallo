# Relay

Relay는 현재 Codex 작업 폴더를 Astra와 GPT-5.6 Sol 파이프라인으로 실행하는 개인용 플러그인입니다. Astra는 분류·계획·검토를, Sol은 구현·수리를 담당합니다. 최소 effort는 medium이며 일반 작업은 high, 복잡한 작업은 xhigh를 사용합니다.

## 동작 방식

Codex에서 작업할 폴더를 열고 평소처럼 요청합니다. 폴더 사전 등록, 상위 허브 연결, `workspace/` 배치는 필요하지 않습니다. SessionStart 훅은 Relay 사용 가능 여부만 알리고, 선택된 `relay` 스킬이 MCP 브리지를 통해 하나의 관리 실행을 시작합니다.

실행은 분류 → 계획 → 구현 → 검사 → Astra 검토 → Knowledge 반영 순서로 진행됩니다. 각 단계의 모델·effort·상태·검사 결과는 채팅과 영속 이벤트 기록에 나타납니다. 실행 기록은 작업 폴더의 `.codex-system/`에, 재사용 가능한 근거 스냅샷은 `%CODEX_HOME%\codex-system\knowledge/`에 저장됩니다. 원본 프로젝트가 이동하거나 삭제되어도 승인된 Knowledge는 유지됩니다.

설치된 외부 스킬은 매 단계 현재 인벤토리에서 발견하고 최대 2개를 선택합니다. Relay는 외부 스킬이나 훅을 설치·수정·삭제하지 않습니다.

## 개발·설치

Node 24 이상, `pnpm`, 로그인된 Codex가 필요합니다. 릴리스는 깨끗한 로컬 Git 커밋에서만 만들 수 있습니다.

```powershell
pnpm install --frozen-lockfile
node --test "test/*.test.mjs"
node src/cli.mjs doctor --json
git commit
node src/cli.mjs release build --ref HEAD
node src/cli.mjs release inspect --runtime C:\Users\<user>\.codex\codex-system\releases\<release-id>
node src/cli.mjs release promote --runtime C:\Users\<user>\.codex\codex-system\releases\<release-id>
```

프로모션은 활성 실행이 없고 패키지 해시·Git 커밋·플러그인 버전이 일치할 때만 성공합니다. 설치본은 개발 소스와 분리된 불변 디렉터리에서 실행됩니다. 플러그인 스냅샷은 기존 작업에 핫 리로드되지 않으므로 업데이트 후 새 Codex 작업에서 확인합니다.

```powershell
node src/cli.mjs release rollback
node src/cli.mjs status --run-id run-...
node src/cli.mjs skills inspect --project C:\path\to\project --stage implementation --file C:\path\to\task.json
node src/cli.mjs backup export --destination C:\path\to\backup
node src/cli.mjs backup import --source C:\path\to\backup
```

롤백은 직전 소유 릴리스로 실행 포인터를 되돌리고 Knowledge와 설정을 보존합니다. 제거도 개인 데이터와 프로젝트 실행 기록을 보존합니다.

## 범위

- 모델: `gpt-6-astra`, `gpt-5.6-sol`
- effort: medium, high, xhigh
- Knowledge 검색: SQLite FTS5와 구조화된 YAML 근거, 최대 3개 패턴 전달
- 수리 한도: Sol 2회, Astra 재계획 1회
- 보류: Jev, 로컬 임베딩, 다중 사용자 서비스, Obsidian 연동

세부 계약과 검증 근거는 [구현 계획](docs/IMPLEMENTATION_PLAN.md)에 기록합니다.

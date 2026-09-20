# Mallo (말로)

경험을 먹고, 당신에게 맞춰지는 작은 생물.

Mallo는 정해진 형태 없이 곁에서 적응하는 개인용 Codex 오케스트레이션 플러그인입니다. 현재 작업 폴더에서 Astra가 분류·계획·검토를, GPT-5.6 Sol이 구현·수리를 맡고, 실제 작업에서 검증된 교훈을 Knowledge에 남겨 다음 작업에 재사용합니다.

## 사용

Codex에서 작업할 폴더를 열고 평소처럼 요청합니다. SessionStart 훅이 Mallo 사용 가능 여부를 알리면 `mallo` 스킬이 MCP 브리지를 통해 하나의 관리 실행을 시작합니다. 폴더 사전 등록, 상위 허브, `workspace/`는 필요하지 않습니다.

실행 기록은 각 프로젝트의 `.codex-system/`에, 재사용 가능한 근거 스냅샷은 `%CODEX_HOME%\codex-system\knowledge/`에 저장됩니다. Mallo는 외부 스킬과 훅을 현재 인벤토리에서 발견해 사용할 뿐 설치·수정·삭제하지 않습니다.

## 개발

Node 24 이상, `pnpm`, 로그인된 Codex가 필요합니다.

```powershell
pnpm install --frozen-lockfile
node --test "test/*.test.mjs"
node src/cli.mjs doctor --json
```

릴리스는 검토된 로컬 Git 커밋에서만 만들며, 활성 실행이 없는 검증된 산출물만 프로모션합니다. 설치본은 개발 소스와 분리하고 직전 릴리스, Knowledge, 설정을 보존합니다. 자세한 계약과 역사적 검증 근거는 [구현 계획](docs/IMPLEMENTATION_PLAN.md)에 있습니다.

범위는 `gpt-6-astra`, `gpt-5.6-sol`, medium/high/xhigh effort입니다. Jev, 로컬 임베딩, 다중 사용자 서비스, Obsidian 연동은 보류합니다.

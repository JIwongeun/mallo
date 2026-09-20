# Mallo (말로)

경험을 먹고, 당신에게 맞춰지는 작은 생물.

Mallo는 현재 작업 폴더에서 동작하는 개인용 Codex 오케스트레이션 플러그인입니다. GPT-5.6 Sol이 medium effort로 요청을 분류하고 구현·수리를 맡으며, 계획이 필요한 작업은 GPT-6 Astra가 계획과 검토를 맡습니다. 실제 실행과 검토 근거가 있는 교훈만 개인 Knowledge에 축적해 다음 작업에서 재사용합니다.

## 사용

Codex에서 대상 폴더를 열고 평소처럼 요청합니다. SessionStart 훅이 Mallo 사용 가능 여부를 알리면 `mallo` 스킬이 하나의 관리 실행을 시작합니다. 폴더 사전 등록, 상위 허브, `workspace/`는 필요하지 않습니다. 단순하고 위험이 낮은 작업은 Astra 계획 단계를 생략할 수 있습니다.

프로젝트별 실행 기록은 `.codex-system/`에 저장됩니다. 개인 데이터 루트는 `CODEX_SYSTEM_DATA_ROOT`가 있으면 그 경로, 없으면 `%CODEX_HOME%\codex-system`이며, `CODEX_HOME`의 기본값은 `%USERPROFILE%\.codex`입니다. 재사용 가능한 근거 스냅샷은 `<data_root>\knowledge`에, 설치 포인터는 `%CODEX_HOME%\codex-system.json`에 저장됩니다. 활성 CLI는 포인터가 가리키는 고정 설치 릴리스의 `src\cli.mjs`입니다.

## 지원 조건

- Windows와 PowerShell
- Node.js 24 이상(지원 기준 Node 24), `pnpm@11.19.0`, Git, `tar`
- 호환되는 로그인된 Codex와 실행 호스트에서 사용 가능한 `gpt-5.6-sol`, `gpt-6-astra`
- 두 모델의 medium, high, xhigh reasoning effort

오프라인 저장소 테스트에는 Codex 로그인이나 자격 증명이 필요하지 않습니다. `doctor`는 실제 Codex, 모델, 스킬, 훅 가용성을 확인하는 별도의 라이브 진단입니다.

```powershell
pnpm install --frozen-lockfile
node --test "test/*.test.mjs"

# 라이브 진단: 로그인된 Codex 필요
node src/cli.mjs doctor --json
```

## 수동 설치와 업데이트

Mallo에는 범용 설치 프로그램이나 자동 업데이트가 없습니다. 검토된 로컬 Git 커밋과 그 커밋에 일치하는 깨끗한 소스 체크아웃에서 다음 명령을 실행합니다.

```powershell
pnpm install --frozen-lockfile
node src/cli.mjs release build --ref HEAD
node src/cli.mjs release inspect --runtime <runtime_root>
node src/cli.mjs install --runtime <runtime_root>
```

`release build`의 JSON 출력에 있는 `runtime_root`를 뒤의 두 명령에 사용합니다. 설치 시 소스 `HEAD`가 빌드 커밋과 일치해야 하고 추적 파일 변경이나 활성 관리 실행이 없어야 합니다. 설치되는 네이티브 ID는 `codex-system@personal`이며, 로컬 marketplace 이름은 `personal`입니다. 네이티브 훅 신뢰가 요청되면 Codex에서 직접 검토해야 하며 Mallo가 자동 승인하지 않습니다. 설치·업데이트 뒤에는 새 Codex 작업에서 플러그인, 스킬, 훅을 다시 발견해야 합니다. 소스 체크아웃을 편집해도 활성 고정 릴리스는 자동으로 바뀌지 않습니다.

현재 지원 범위는 Windows 설치, Astra/Sol 라우팅, 수동 릴리스 교체입니다. Mallo는 외부 스킬과 훅을 발견해 선택하지만 설치·수정·삭제하지 않습니다. Jev, 로컬 임베딩, 다중 사용자 서비스, Obsidian 연동은 보류되어 있습니다.

## 저장소와 기여

저장소: [https://github.com/JIwongeun/mallo](https://github.com/JIwongeun/mallo)

변경은 `codex/*` 브랜치에서 만들고 pull request에 수용 기준, 실행한 검사, 보류된 검사 또는 환경 제약, 알려진 제한을 기록합니다. 병합 전 컨트롤러가 오프라인 테스트와 workflow YAML을 독립적으로 검증합니다. 릴리스 태그는 `vMAJOR.MINOR.PATCH` 형식의 불변 태그이며, 기존 태그의 대상을 이동하지 않습니다.

상세 런타임 계약과 과거 검증 근거는 [구현 계획](docs/IMPLEMENTATION_PLAN.md)에 보존되어 있습니다.

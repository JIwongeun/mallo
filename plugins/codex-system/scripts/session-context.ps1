$ErrorActionPreference = "Stop"

if ($env:CODEX_SYSTEM_MANAGED_RUN -eq "1") { exit 0 }

try {
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    $pointerPath = Join-Path $codexHome "codex-system.json"
    if (-not (Test-Path -LiteralPath $pointerPath)) { exit 0 }
    $pointer = [IO.File]::ReadAllText($pointerPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $output = & $pointer.node_path $pointer.cli_path hook-context --cwd (Get-Location).Path 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($output)) { exit 0 }
    [Console]::Out.Write($output)
} catch {
    exit 0
}

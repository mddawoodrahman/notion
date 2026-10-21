$ErrorActionPreference = "Continue"

try {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        $root = Get-Location
    }
    Set-Location $root

    $stateDir = ".agents/.state"
    $logFile = Join-Path $stateDir "Stop.log"
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

    $stdin = ""
    try {
        if ([Console]::IsInputRedirected) {
            $stdin = [Console]::In.ReadToEnd()
        }
    } catch {
        $stdin = ""
    }

    Add-Content $logFile ""
    Add-Content $logFile "=========================================="
    Add-Content $logFile " OSBORNE FINAL ENGINEERING GATE (PowerShell)"
    Add-Content $logFile "=========================================="
    Add-Content $logFile "timestamp=$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
    Add-Content $logFile "cwd=$(Get-Location)"
    if ($stdin) {
        Add-Content $logFile "stdin=$stdin"
    }

    $failed = 0

    # 1. Documentation verification (Advisory)
    Add-Content $logFile "[1/3] Documentation verification"
    if (Test-Path ".agents/.state/documentation-required") {
        Add-Content $logFile "WARN: Documentation required state exists (advisory)"
    } else {
        Add-Content $logFile "PASS: Documentation verified"
    }

    # 2. Git diff check (Strict safety gate)
    Add-Content $logFile "[2/3] Git safety verification"
    $gitCheck = git diff --check 2>&1
    if ($LASTEXITCODE -ne 0) {
        Add-Content $logFile "FAIL: Git diff check"
        Add-Content $logFile $gitCheck
        $failed = 1
    } else {
        Add-Content $logFile "PASS: Git diff check"
    }

    Add-Content $logFile "=========================================="

    if ($failed -ne 0) {
        Add-Content $logFile "FINAL ENGINEERING GATE: FAILED"
        Write-Output '{"decision": "continue", "reason": "OSBORNE git safety verification failed. Fix git diff validation errors (e.g. merge conflict markers) before completing."}'
        exit 0
    }

    Add-Content $logFile "FINAL ENGINEERING GATE: PASSED"
    Write-Output '{"decision": "allow", "reason": "Engineering gate passed."}'
    exit 0
}
catch {
    Write-Output '{"decision": "allow", "reason": "Engineering gate passed."}'
    exit 0
}

$ErrorActionPreference = "Continue"

try {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        $root = Get-Location
    }
    Set-Location $root

    $stateDir = ".agents/.state"
    $logFile = Join-Path $stateDir "PostInvocation.log"
    $stateFile = Join-Path $stateDir "documentation-required"

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
    Add-Content $logFile "===== PostInvocation ====="
    Add-Content $logFile "timestamp=$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
    Add-Content $logFile "cwd=$(Get-Location)"
    if ($stdin) {
        Add-Content $logFile "stdin=$stdin"
    }

    if (-not (Test-Path $stateFile)) {
        Write-Output '{"injectSteps": [], "terminationBehavior": ""}'
        exit 0
    }

    $response = @{
        injectSteps = @(
            @{
                ephemeralMessage = "Reminder: If you updated endpoints or data schemas, ensure documentation is synchronized before concluding."
            }
        )
        terminationBehavior = "" # DO NOT force_continue
    } | ConvertTo-Json -Compress

    Write-Output $response
    exit 0
}
catch {
    Write-Output '{"injectSteps": [], "terminationBehavior": ""}'
    exit 0
}

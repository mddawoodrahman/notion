$ErrorActionPreference = "Continue"

try {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        $root = Get-Location
    }
    Set-Location $root

    $stateDir = ".agents/.state"
    $logFile = Join-Path $stateDir "PostToolUse.log"
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
    Add-Content $logFile "===== PostToolUse ====="
    Add-Content $logFile "timestamp=$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
    Add-Content $logFile "cwd=$(Get-Location)"
    if ($stdin) {
        Add-Content $logFile "stdin=$stdin"
    }

    $targetFile = ""
    if ($stdin) {
        try {
            $payload = $stdin | ConvertFrom-Json
            if ($payload.toolCall.args.TargetFile) {
                $targetFile = [string]$payload.toolCall.args.TargetFile
            } elseif ($payload.toolCall.args.target_file) {
                $targetFile = [string]$payload.toolCall.args.target_file
            } elseif ($payload.toolCall.args.path) {
                $targetFile = [string]$payload.toolCall.args.path
            }
        } catch {
            if ($stdin -match '"TargetFile"\s*:\s*"([^"]+)"') {
                $targetFile = $matches[1]
            }
        }
    }

    if ($targetFile) {
        $normalized = $targetFile -replace '\\', '/'
        $isAppOrPkg = $normalized -match '(?i)(?:^|/)(apps|packages)/'
        $isDoc = $normalized -match '(?i)(README\.md$|/docs/|\.agents/)'

        if ($isAppOrPkg -and -not $isDoc) {
            Set-Content -Path $stateFile -Value $targetFile
        } elseif ($isDoc) {
            if (Test-Path $stateFile) {
                Remove-Item $stateFile -Force
            }
        }
    } else {
        # Targeted check limited strictly to apps and packages directories
        $status = @(git status --porcelain apps packages 2>$null)
        $hasUnsyncedCode = $false
        foreach ($line in $status) {
            $trimmed = $line.Substring(3).Trim() -replace '\\', '/'
            if ($trimmed -and -not ($trimmed -match '(?i)(README\.md$|/docs/)')) {
                $hasUnsyncedCode = $true
                break
            }
        }

        if ($hasUnsyncedCode) {
            Set-Content -Path $stateFile -Value "apps/packages modified"
        } else {
            if (Test-Path $stateFile) {
                Remove-Item $stateFile -Force
            }
        }
    }

    Write-Output "{}"
    exit 0
}
catch {
    if (Test-Path $stateDir) {
        Add-Content (Join-Path $stateDir "PostToolUse.log") "ERROR: $_"
    }
    Write-Output "{}"
    exit 0
}

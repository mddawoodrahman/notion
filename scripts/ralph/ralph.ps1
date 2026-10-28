[CmdletBinding()]
param(
    [ValidateSet("amp", "claude")]
    [string]$Tool = "amp",

    [int]$MaxIterations = 10
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PrdFile = Join-Path $ScriptDir "prd.json"
if (-not (Test-Path $PrdFile)) {
    $RootPrd = Join-Path $ScriptDir "..\..\prd.json"
    if (Test-Path $RootPrd) {
        $PrdFile = (Resolve-Path $RootPrd).Path
    }
}

$ProgressFile = Join-Path $ScriptDir "progress.txt"
$ArchiveDir = Join-Path $ScriptDir "archive"
$LastBranchFile = Join-Path $ScriptDir ".last-branch"

# Archive previous run if branch changed
if ((Test-Path $PrdFile) -and (Test-Path $LastBranchFile)) {
    try {
        $prd = Get-Content $PrdFile -Raw | ConvertFrom-Json
        $currentBranch = $prd.branchName
    } catch {
        $currentBranch = ""
    }
    $lastBranch = (Get-Content $LastBranchFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()

    if ($currentBranch -and $lastBranch -and ($currentBranch -ne $lastBranch)) {
        $date = Get-Date -Format "yyyy-MM-dd"
        $folderName = $lastBranch -replace '^ralph/', ''
        $archiveFolder = Join-Path $ArchiveDir "$date-$folderName"
        Write-Host "Archiving previous run: $lastBranch"
        New-Item -ItemType Directory -Force -Path $archiveFolder | Out-Null
        if (Test-Path $PrdFile) { Copy-Item $PrdFile -Destination $archiveFolder }
        if (Test-Path $ProgressFile) { Copy-Item $ProgressFile -Destination $archiveFolder }
        Write-Host "   Archived to: $archiveFolder"

        Set-Content -Path $ProgressFile -Value @(
            "# Ralph Progress Log",
            "Started: $(Get-Date)",
            "---"
        )
    }
}

# Track current branch
if (Test-Path $PrdFile) {
    try {
        $prd = Get-Content $PrdFile -Raw | ConvertFrom-Json
        if ($prd.branchName) {
            Set-Content -Path $LastBranchFile -Value $prd.branchName
        }
    } catch {}
}

# Initialize progress file if missing
if (-not (Test-Path $ProgressFile)) {
    Set-Content -Path $ProgressFile -Value @(
        "# Ralph Progress Log",
        "Started: $(Get-Date)",
        "---"
    )
}

Write-Host "Starting Ralph - Tool: $Tool - Max iterations: $MaxIterations" -ForegroundColor Cyan

for ($i = 1; $i -le $MaxIterations; $i++) {
    Write-Host ""
    Write-Host "===============================================================" -ForegroundColor Yellow
    Write-Host "  Ralph Iteration $i of $MaxIterations ($Tool)" -ForegroundColor Yellow
    Write-Host "===============================================================" -ForegroundColor Yellow

    $promptFile = if ($Tool -eq "amp") { Join-Path $ScriptDir "prompt.md" } else { Join-Path $ScriptDir "CLAUDE.md" }

    if ($Tool -eq "amp") {
        $output = Get-Content $promptFile -Raw | amp --dangerously-allow-all 2>&1
    } else {
        $output = Get-Content $promptFile -Raw | claude --dangerously-skip-permissions --print 2>&1
    }

    $output | ForEach-Object { Write-Host $_ }

    if ($output -match "<promise>COMPLETE</promise>") {
        Write-Host ""
        Write-Host "Ralph completed all tasks!" -ForegroundColor Green
        Write-Host "Completed at iteration $i of $MaxIterations" -ForegroundColor Green
        exit 0
    }

    Write-Host "Iteration $i complete. Continuing..."
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Ralph reached max iterations ($MaxIterations) without completing all tasks." -ForegroundColor Red
Write-Host "Check $ProgressFile for status."
exit 1

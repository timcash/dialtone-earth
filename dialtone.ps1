# dialtone.ps1: Simplified orchestrator wrapper for PowerShell.
# Ported from dialtone.sh.

$ErrorActionPreference = "Stop"
$ScriptArgs = @($args)
$env:DIALTONE_USE_NIX = if ([string]::IsNullOrWhiteSpace($env:DIALTONE_USE_NIX)) { "1" } else { $env:DIALTONE_USE_NIX }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir "env/dialtone.json"
$env:DIALTONE_REPO_ROOT = $ScriptDir
$env:DIALTONE_SRC_ROOT = Join-Path $ScriptDir "src"

function Resolve-WslExecutable {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace([System.Environment]::SystemDirectory)) {
        $candidates += (Join-Path ([System.Environment]::SystemDirectory) "wsl.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        $candidates += (Join-Path $env:SystemRoot "System32\\wsl.exe")
        $candidates += (Join-Path $env:SystemRoot "Sysnative\\wsl.exe")
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        return $command.Source
    }

    throw "WSL is required, but wsl.exe was not found in PATH or the standard Windows locations."
}

function Write-EnvFile {
    param(
        [Parameter(Mandatory = $true)][string]$EnvFilePath,
        [Parameter(Mandatory = $true)][string]$DialtoneHome,
        [Parameter(Mandatory = $true)][string]$DialtoneEnv
    )
    $envDir = Split-Path -Parent $EnvFilePath
    New-Item -ItemType Directory -Path $envDir -Force | Out-Null
    @{
        DIALTONE_HOME = $DialtoneHome
        DIALTONE_ENV = $DialtoneEnv
        DIALTONE_GO_CACHE_DIR = (Join-Path $DialtoneEnv "cache/go")
        DIALTONE_BUN_CACHE_DIR = (Join-Path $DialtoneEnv "cache/bun")
        DIALTONE_REPO_ROOT = $ScriptDir
        DIALTONE_USE_NIX = "1"
    } | ConvertTo-Json | Set-Content -Path $EnvFilePath -Encoding UTF8
}

function Convert-ToWslPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $p = if (Test-Path -LiteralPath $Path) {
        (Resolve-Path -LiteralPath $Path).Path
    } else {
        $Path
    }
    if ($p -match '^([A-Za-z]):\\(.*)$') {
        $drive = $matches[1].ToLower()
        $rest = $matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }
    return ($p -replace '\\', '/')
}

function Escape-BashArg {
    param([Parameter(Mandatory = $true)][string]$Value)
    $replacement = "'`"`'`"`'"
    return "'" + ($Value -replace "'", $replacement) + "'"
}

function Convert-EnvPathToWsl {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    if ($Path -match '^[A-Za-z]:\\') {
        return Convert-ToWslPath -Path $Path
    }
    return ($Path -replace '\\', '/')
}

function Get-ArrayTail {
    param(
        [Parameter(Mandatory = $true)][object[]]$Values,
        [Parameter(Mandatory = $true)][int]$StartIndex
    )

    if ($StartIndex -ge $Values.Count) {
        return ,@()
    }
    $tail = @($Values[$StartIndex..($Values.Count - 1)])
    return ,$tail
}

function Get-DialtoneTmuxInvocationArgs {
    if ($ScriptArgs.Length -eq 0) {
        return $null
    }

    $first = $ScriptArgs[0].Trim().ToLowerInvariant()
    if ($first -eq "tmux") {
        return ,(Get-ArrayTail -Values $ScriptArgs -StartIndex 1)
    }

    if ($first -ne "wsl" -or $ScriptArgs.Length -lt 2) {
        return $null
    }

    $second = $ScriptArgs[1].Trim().ToLowerInvariant()
    if ($second -match '^src_v\d+$') {
        if ($ScriptArgs.Length -ge 3 -and $ScriptArgs[2].Trim().ToLowerInvariant() -eq "tmux") {
            return ,(Get-ArrayTail -Values $ScriptArgs -StartIndex 3)
        }
        return $null
    }

    if ($second -eq "tmux") {
        return ,(Get-ArrayTail -Values $ScriptArgs -StartIndex 2)
    }

    return $null
}

function ConvertTo-BashSingleQuoted {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return $Value.Replace("'", "'""'""'")
}

function Get-DefaultWslTmuxCwd {
    if (Test-Path -LiteralPath $EnvFile) {
        try {
            $config = Get-Content -LiteralPath $EnvFile -Raw | ConvertFrom-Json
            $repoRoot = [string]$config.DIALTONE_REPO_ROOT
            if (-not [string]::IsNullOrWhiteSpace($repoRoot)) {
                return (Convert-ToWslPath -Path $repoRoot)
            }
        }
        catch {
        }
    }
    return "/home/user/dialtone"
}

function Get-DefaultWslTmuxSession {
    if (-not [string]::IsNullOrWhiteSpace($env:DIALTONE_WSL_TERMINAL_TMUX_SESSION)) {
        return $env:DIALTONE_WSL_TERMINAL_TMUX_SESSION.Trim()
    }
    if (Test-Path -LiteralPath $EnvFile) {
        try {
            $config = Get-Content -LiteralPath $EnvFile -Raw | ConvertFrom-Json
            $session = [string]$config.DIALTONE_WSL_TERMINAL_TMUX_SESSION
            if (-not [string]::IsNullOrWhiteSpace($session)) {
                return $session.Trim()
            }
        }
        catch {
        }
    }
    return "dialtone"
}

function Invoke-DialtoneTmuxBash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Script,
        [string]$Distro = ""
    )

    $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("dialtone-tmux-" + [guid]::NewGuid().ToString("N") + ".sh")
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempFile, $Script, $utf8NoBom)

    $root = [System.IO.Path]::GetPathRoot($tempFile).TrimEnd('\').TrimEnd(':').ToLowerInvariant()
    $relative = $tempFile.Substring(3).Replace('\', '/')
    $linuxPath = "/mnt/$root/$relative"

    $wslArgs = @()
    if (-not [string]::IsNullOrWhiteSpace($Distro)) {
        $wslArgs += "-d"
        $wslArgs += $Distro
    }
    $wslArgs += "bash"
    $wslArgs += $linuxPath

    try {
        $wslExe = Resolve-WslExecutable
        & $wslExe @wslArgs
        if ($LASTEXITCODE -ne 0) {
            throw "wsl command failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-DialtoneTmux {
    $tmuxArgs = Get-DialtoneTmuxInvocationArgs
    if ($null -eq $tmuxArgs) {
        return
    }

    $script:DialtoneTmuxHandled = $true

    $null = Resolve-WslExecutable

    $Action = ""
    $Session = Get-DefaultWslTmuxSession
    $Distro = ""
    $Cwd = ""
    $Lines = 120
    $Width = 120
    $Height = 40
    $WaitMs = 500
    $CommandArgs = New-Object System.Collections.Generic.List[string]

    for ($i = 0; $i -lt $tmuxArgs.Count; $i++) {
        $arg = [string]$tmuxArgs[$i]
        switch ($arg) {
            "-Session" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-Session requires a value" }
                $Session = [string]$tmuxArgs[$i]
                continue
            }
            "-Distro" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-Distro requires a value" }
                $Distro = [string]$tmuxArgs[$i]
                continue
            }
            "-Cwd" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-Cwd requires a value" }
                $Cwd = [string]$tmuxArgs[$i]
                continue
            }
            "-Lines" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-Lines requires a value" }
                $Lines = [int]$tmuxArgs[$i]
                continue
            }
            "-Width" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-Width requires a value" }
                $Width = [int]$tmuxArgs[$i]
                continue
            }
            "-Height" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-Height requires a value" }
                $Height = [int]$tmuxArgs[$i]
                continue
            }
            "-WaitMs" {
                $i++
                if ($i -ge $tmuxArgs.Count) { throw "-WaitMs requires a value" }
                $WaitMs = [int]$tmuxArgs[$i]
                continue
            }
            "--" {
                $remaining = Get-ArrayTail -Values $tmuxArgs -StartIndex ($i + 1)
                foreach ($remainingArg in $remaining) {
                    $CommandArgs.Add([string]$remainingArg)
                }
                $i = $tmuxArgs.Count
                continue
            }
            default {
                if ([string]::IsNullOrWhiteSpace($Action)) {
                    $Action = $arg
                } else {
                    $CommandArgs.Add($arg)
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($Cwd)) {
        $Cwd = Get-DefaultWslTmuxCwd
    }

    $knownActions = @("help", "ensure", "attach", "send", "read", "clear", "interrupt", "list", "status", "clean-state")
    if ([string]::IsNullOrWhiteSpace($Action)) {
        if ($CommandArgs.Count -gt 0) {
            $Action = "send"
        } else {
            $Action = "read"
        }
    } elseif ($knownActions -notcontains $Action) {
        $CommandArgs.Insert(0, $Action)
        $Action = "send"
    }

    function Ensure-DialtoneTmuxSession {
        $safeSession = ConvertTo-BashSingleQuoted $Session
        $safeCwd = ConvertTo-BashSingleQuoted $Cwd
        Invoke-DialtoneTmuxBash -Distro $Distro -Script @"
if ! tmux has-session -t '$safeSession' 2>/dev/null; then
  tmux new-session -d -s '$safeSession' -c '$safeCwd' -x $Width -y $Height
fi
"@
    }

    switch ($Action) {
        "help" {
            @"
Usage:
  .\dialtone.ps1 tmux [command...]
  .\dialtone.ps1 tmux help
  .\dialtone.ps1 tmux read
  .\dialtone.ps1 tmux clear
  .\dialtone.ps1 tmux clean-state
  .\dialtone.ps1 tmux interrupt
  .\dialtone.ps1 tmux ensure
  .\dialtone.ps1 tmux attach
  .\dialtone.ps1 tmux list
  .\dialtone.ps1 tmux status

Aliases:
  .\dialtone.ps1 wsl tmux ...
  .\dialtone.ps1 wsl src_v3 tmux ...

Defaults:
  Session: $Session
  Cwd:     $Cwd

Behavior:
  - No arguments reads the current pane.
  - An unknown first argument is treated as a command to send.
  - send clears the current shell input line before typing the command.
  - interrupt sends Ctrl-C without killing the tmux session.
  - attach opens a visible WSL terminal client on the chosen session.
  - The visible `wsl src_v3 terminal` window attaches to this same default session.
"@ | Write-Output
        }
        "ensure" {
            Ensure-DialtoneTmuxSession
        }
        "attach" {
            Ensure-DialtoneTmuxSession
            $wslExe = Resolve-WslExecutable
            $attachArgs = New-Object System.Collections.Generic.List[string]
            if (-not [string]::IsNullOrWhiteSpace($Distro)) {
                $attachArgs.Add("-d")
                $attachArgs.Add($Distro)
            }
            $attachArgs.Add("--cd")
            $attachArgs.Add($Cwd)
            $attachArgs.Add("--")
            $attachArgs.Add("tmux")
            $attachArgs.Add("attach-session")
            $attachArgs.Add("-t")
            $attachArgs.Add($Session)
            Start-Process -FilePath $wslExe -WindowStyle Normal -ArgumentList $attachArgs | Out-Null
        }
        "list" {
            Invoke-DialtoneTmuxBash -Distro $Distro -Script "tmux list-sessions"
        }
        "status" {
            Ensure-DialtoneTmuxSession
            $safeSession = ConvertTo-BashSingleQuoted $Session
            Invoke-DialtoneTmuxBash -Distro $Distro -Script @"
tmux has-session -t '$safeSession' 2>/dev/null
tmux display-message -p -t '$safeSession' 'session=#{session_name} clients=#{session_attached} window=#{window_index}:#{window_name} pane=#{pane_index} cwd=#{pane_current_path} pid=#{pane_pid}'
tmux capture-pane -pt '$safeSession' -S -20
"@
        }
        "read" {
            Ensure-DialtoneTmuxSession
            $safeSession = ConvertTo-BashSingleQuoted $Session
            Invoke-DialtoneTmuxBash -Distro $Distro -Script "tmux capture-pane -pt '$safeSession' -S -$Lines"
        }
        "clear" {
            Ensure-DialtoneTmuxSession
            $safeSession = ConvertTo-BashSingleQuoted $Session
            Invoke-DialtoneTmuxBash -Distro $Distro -Script @"
tmux copy-mode -q -t '$safeSession' >/dev/null 2>&1 || true
tmux send-keys -t '$safeSession' C-l
sleep $(('{0:N3}' -f ($WaitMs / 1000)).Replace(',', ''))
tmux capture-pane -pt '$safeSession' -S -$Lines
"@
        }
        "clean-state" {
            Ensure-DialtoneTmuxSession
            $safeSession = ConvertTo-BashSingleQuoted $Session
            Invoke-DialtoneTmuxBash -Distro $Distro -Script @"
tmux copy-mode -q -t '$safeSession' >/dev/null 2>&1 || true
tmux send-keys -t '$safeSession' C-c
tmux send-keys -t '$safeSession' C-u
tmux send-keys -t '$safeSession' C-l
tmux clear-history -t '$safeSession'
sleep $(('{0:N3}' -f ($WaitMs / 1000)).Replace(',', ''))
tmux capture-pane -pt '$safeSession' -S -$Lines
"@
        }
        "interrupt" {
            Ensure-DialtoneTmuxSession
            $safeSession = ConvertTo-BashSingleQuoted $Session
            Invoke-DialtoneTmuxBash -Distro $Distro -Script @"
tmux copy-mode -q -t '$safeSession' >/dev/null 2>&1 || true
tmux send-keys -t '$safeSession' C-c
sleep $(('{0:N3}' -f ($WaitMs / 1000)).Replace(',', ''))
tmux capture-pane -pt '$safeSession' -S -$Lines
"@
        }
        "send" {
            if ($CommandArgs.Count -eq 0) {
                throw "send requires a command string"
            }

            Ensure-DialtoneTmuxSession
            $safeSession = ConvertTo-BashSingleQuoted $Session
            $commandText = ($CommandArgs -join " ").Trim()
            $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($commandText))
            Invoke-DialtoneTmuxBash -Distro $Distro -Script @"
cmd_b64='$encodedCommand'
cmd_text=`$(printf '%s' "`$cmd_b64" | base64 -d)
tmux copy-mode -q -t '$safeSession' >/dev/null 2>&1 || true
tmux send-keys -t '$safeSession' C-u
tmux send-keys -l -t '$safeSession' "`$cmd_text"
tmux send-keys -t '$safeSession' C-m
sleep $(('{0:N3}' -f ($WaitMs / 1000)).Replace(',', ''))
tmux capture-pane -pt '$safeSession' -S -$Lines
"@
        }
    }

}

Invoke-DialtoneTmux
if ($script:DialtoneTmuxHandled) {
    exit $LASTEXITCODE
}

function Get-WslPluginSubcommand {
    param([string[]]$Args)
    if ($Args.Length -lt 2) { return "" }

    $first = $Args[1].Trim().ToLowerInvariant()
    if ($first -match '^src_v\d+$') {
        if ($Args.Length -lt 3) { return "" }
        return $Args[2].Trim().ToLowerInvariant()
    }

    if ($Args.Length -ge 3) {
        $second = $Args[2].Trim().ToLowerInvariant()
        if ($second -match '^src_v\d+$') {
            return $first
        }
    }

    return $first
}

function Should-InvokeWslPluginViaShell {
    if ($ScriptArgs.Length -eq 0 -or $ScriptArgs[0] -ne "wsl") {
        return $false
    }

    $subcommand = Get-WslPluginSubcommand -Args $ScriptArgs
    switch ($subcommand) {
        { $_ -in @("", "help", "-h", "--help", "list", "ls", "status", "create", "spawn", "start", "stop", "delete", "rm", "exec", "terminal", "open-terminal") } {
            return $false
        }
        default {
            return $true
        }
    }
}

function Use-WindowsLocalDialtonePaths {
    if ($ScriptArgs.Length -eq 0 -or $ScriptArgs[0] -ne "wsl") {
        return
    }
    if (Should-InvokeWslPluginViaShell) {
        return
    }

    $localHome = Join-Path $env:USERPROFILE ".dialtone"
    $localEnv = Join-Path $env:USERPROFILE ".dialtone_env"

    if ([string]::IsNullOrWhiteSpace($env:DIALTONE_HOME) -or $env:DIALTONE_HOME.StartsWith("/")) {
        $env:DIALTONE_HOME = $localHome
    }
    if ([string]::IsNullOrWhiteSpace($env:DIALTONE_ENV) -or $env:DIALTONE_ENV.StartsWith("/")) {
        $env:DIALTONE_ENV = $localEnv
    }
    if ([string]::IsNullOrWhiteSpace($env:DIALTONE_REPO_ROOT) -or $env:DIALTONE_REPO_ROOT.StartsWith("/")) {
        $env:DIALTONE_REPO_ROOT = $ScriptDir
    }
    if ([string]::IsNullOrWhiteSpace($env:DIALTONE_GO_CACHE_DIR) -or $env:DIALTONE_GO_CACHE_DIR.StartsWith("/")) {
        $env:DIALTONE_GO_CACHE_DIR = Join-Path $env:DIALTONE_ENV "cache/go"
    }
    if ([string]::IsNullOrWhiteSpace($env:DIALTONE_BUN_CACHE_DIR) -or $env:DIALTONE_BUN_CACHE_DIR.StartsWith("/")) {
        $env:DIALTONE_BUN_CACHE_DIR = Join-Path $env:DIALTONE_ENV "cache/bun"
    }

    $env:DIALTONE_SRC_ROOT = Join-Path $ScriptDir "src"
}

function Invoke-WslPluginViaShell {
    $wslExe = Resolve-WslExecutable

    $wslRepo = Convert-ToWslPath -Path $ScriptDir
    $resolvedHome = if ([string]::IsNullOrWhiteSpace($env:DIALTONE_HOME)) {
        Join-Path $env:USERPROFILE ".dialtone"
    } else {
        $env:DIALTONE_HOME
    }
    $resolvedEnv = if ([string]::IsNullOrWhiteSpace($env:DIALTONE_ENV)) {
        Join-Path $env:USERPROFILE ".dialtone_env"
    } else {
        $env:DIALTONE_ENV
    }
    $wslHome = Convert-EnvPathToWsl -Path $resolvedHome
    $wslEnv = Convert-EnvPathToWsl -Path $resolvedEnv
    $wslEnvFile = Convert-ToWslPath -Path $EnvFile

    $escapedArgs = @()
    foreach ($a in $ScriptArgs) { $escapedArgs += (Escape-BashArg -Value $a) }
    $argTail = [string]::Join(" ", $escapedArgs)
    $cmd = "cd $(Escape-BashArg -Value $wslRepo) && export DIALTONE_ONBOARDING_DONE=1 && export DIALTONE_REPO_ROOT=$(Escape-BashArg -Value $wslRepo) && export DIALTONE_ENV_FILE=$(Escape-BashArg -Value $wslEnvFile) && export DIALTONE_HOME=$(Escape-BashArg -Value $wslHome) && export DIALTONE_ENV=$(Escape-BashArg -Value $wslEnv) && export DIALTONE_USE_NIX=0 && ./dialtone.sh $argTail"

    Write-Host "DIALTONE> Running wsl plugin via WSL shell..."
    & $wslExe -e bash -lc $cmd
    exit $LASTEXITCODE
}

if (Should-InvokeWslPluginViaShell) {
    Invoke-WslPluginViaShell
}

function Enter-NixShellIfNeeded {
    if ($env:DIALTONE_USE_NIX -in @("0","false","False","no","off")) { return }
    if (![string]::IsNullOrWhiteSpace($env:IN_NIX_SHELL)) { return }
    if ($env:DIALTONE_NIX_SHELL_BOOTSTRAPPED -eq "1") { return }

    $flakePath = Join-Path $ScriptDir "flake.nix"
    if (!(Test-Path $flakePath)) { return }

    $wslExe = Resolve-WslExecutable

    $wslRepo = Convert-ToWslPath -Path $ScriptDir
    $escapedArgs = @()
    foreach ($a in $ScriptArgs) { $escapedArgs += (Escape-BashArg -Value $a) }
    $argTail = [string]::Join(" ", $escapedArgs)
    $cmd = "cd $(Escape-BashArg -Value $wslRepo) && export DIALTONE_NIX_SHELL_BOOTSTRAPPED=1 && ./dialtone.sh $argTail"

    Write-Host "DIALTONE> Entering WSL + Nix shell..."
    & $wslExe -e bash -lc $cmd
    exit $LASTEXITCODE
}

function Bootstrap-CloneRepoInPlace {
    param(
        [Parameter(Mandatory = $true)][string]$RepoUrl,
        [Parameter(Mandatory = $true)][string]$Branch
    )
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git is required to bootstrap the repository."
    }

    $ps1Path = Join-Path $ScriptDir "dialtone.ps1"
    if (Test-Path $ps1Path) {
        Copy-Item $ps1Path "$ps1Path.back" -Force
        Write-Host "DIALTONE> Backed up launcher: $ps1Path.back"
    }

    if (-not (Test-Path (Join-Path $ScriptDir ".git"))) {
        & git -C $ScriptDir init | Out-Null
        & git -C $ScriptDir remote add origin $RepoUrl
    } else {
        & git -C $ScriptDir remote get-url origin *> $null
        if ($LASTEXITCODE -ne 0) {
            & git -C $ScriptDir remote add origin $RepoUrl
        }
    }

    & git -C $ScriptDir fetch --depth 1 origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    & git -C $ScriptDir checkout -f -B $Branch FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
}

function Run-BootstrapRepl {
    param(
        [Parameter(Mandatory = $true)][string]$EnvFilePath
    )
    $defaultHome = Join-Path $env:USERPROFILE ".dialtone"
    $defaultEnv = Join-Path $env:USERPROFILE ".dialtone_env"
    $defaultRepo = "https://github.com/timcash/dialtone.git"
    $defaultBranch = "main"

    Write-Host "DIALTONE> Bootstrap REPL started."
    Write-Host "DIALTONE> This will configure env/dialtone.json and bootstrap the dialtone repo."
    Write-Host "DIALTONE> Runtime/tooling install happens in WSL + Nix shell after bootstrap."

    $inputHome = Read-Host "DIALTONE> Dialtone home directory [default: $defaultHome]"
    if ([string]::IsNullOrWhiteSpace($inputHome)) { $inputHome = $defaultHome }
    if ($inputHome.StartsWith("~")) {
        $inputHome = Join-Path $env:USERPROFILE $inputHome.Substring(1).TrimStart("\/")
    }
    New-Item -ItemType Directory -Path $inputHome -Force | Out-Null
    $env:DIALTONE_HOME = $inputHome

    $inputEnv = Read-Host "DIALTONE> Dependency directory [default: $defaultEnv]"
    if ([string]::IsNullOrWhiteSpace($inputEnv)) { $inputEnv = $defaultEnv }
    if ($inputEnv.StartsWith("~")) {
        $inputEnv = Join-Path $env:USERPROFILE $inputEnv.Substring(1).TrimStart("\/")
    }
    New-Item -ItemType Directory -Path $inputEnv -Force | Out-Null
    $env:DIALTONE_ENV = $inputEnv

    Write-EnvFile -EnvFilePath $EnvFilePath -DialtoneHome $env:DIALTONE_HOME -DialtoneEnv $env:DIALTONE_ENV
    Write-Host "DIALTONE> Wrote $EnvFilePath"

    $repoInput = Read-Host "DIALTONE> Git repo to bootstrap [default: $defaultRepo]"
    if ([string]::IsNullOrWhiteSpace($repoInput)) { $repoInput = $defaultRepo }
    $branchInput = Read-Host "DIALTONE> Branch [default: $defaultBranch]"
    if ([string]::IsNullOrWhiteSpace($branchInput)) { $branchInput = $defaultBranch }

    Write-Host "DIALTONE> Bootstrapping repo in $ScriptDir ..."
    Bootstrap-CloneRepoInPlace -RepoUrl $repoInput -Branch $branchInput
    Write-Host "DIALTONE> Repo bootstrap complete."
    Write-Host "DIALTONE> Launching new dialtone runtime..."

    $env:DIALTONE_BOOTSTRAP_DONE = "1"
    & (Join-Path $ScriptDir "dialtone.ps1") @Script:ScriptArgs
    exit $LASTEXITCODE
}

function Test-IsLocalCliTestInvocation {
    $filtered = New-Object System.Collections.Generic.List[string]
    foreach ($raw in $ScriptArgs) {
        $arg = [string]$raw
        $trimmed = $arg.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed -eq "--stdout" -or $trimmed -eq "--no-stdout") {
            continue
        }
        $filtered.Add($trimmed)
    }
    if ($filtered.Count -gt 0 -and $filtered[0] -eq "loop") {
        # Validate original argv before bootstrap and before global flag processing.
        $validOnce = $ScriptArgs.Count -eq 2 -and $ScriptArgs[1] -ceq '--once'
        $validRepeat = $ScriptArgs.Count -eq 3 -and $ScriptArgs[1] -ceq '--max-count' -and $ScriptArgs[2] -cmatch '^([1-9]|[1-3][0-9]|4[0-8])$'
        if ($ScriptArgs[0] -cne 'loop' -or (-not $validOnce -and -not $validRepeat)) {
            [Console]::Error.WriteLine('usage: dialtone loop --once | --max-count N (1-48)')
            exit 2
        }
        return $true
    }
    if ($filtered.Count -eq 0 -or $filtered[0].ToLowerInvariant() -ne "test") {
        return $false
    }
    for ($i = 1; $i -lt $filtered.Count; $i++) {
        $a = $filtered[$i].ToLowerInvariant()
        if ($a -in @("--ssh-host", "--target-host", "--host") -or
            $a.StartsWith("--ssh-host=") -or
            $a.StartsWith("--target-host=") -or
            $a.StartsWith("--host=")) {
            return $false
        }
    }
    if ($filtered.Count -ge 2 -and $filtered[1].ToLowerInvariant() -match '^src_v\d+$') {
        return $false
    }
    if ($filtered.Count -ge 3 -and $filtered[2].ToLowerInvariant() -match '^src_v\d+$') {
        return $false
    }
    return $true
}

$IsLocalCliTest = Test-IsLocalCliTestInvocation

# 1. Load Environment
if ([string]::IsNullOrWhiteSpace($env:DIALTONE_ENV_FILE)) {
    $env:DIALTONE_ENV_FILE = $EnvFile
}
if (-not $IsLocalCliTest) {
    if (!(Test-Path $EnvFile) -and [string]::IsNullOrWhiteSpace($env:DIALTONE_BOOTSTRAP_DONE)) {
        Run-BootstrapRepl -EnvFilePath $EnvFile
    }
    if (Test-Path $EnvFile) {
        $config = Get-Content $EnvFile -Raw | ConvertFrom-Json
        $config.PSObject.Properties | ForEach-Object {
            [System.Environment]::SetEnvironmentVariable($_.Name, [string]$_.Value, "Process")
        }
    }
    Use-WindowsLocalDialtonePaths

    Enter-NixShellIfNeeded
} else {
    $env:DIALTONE_USE_NIX = "0"
    $env:DIALTONE_LOG_NATS = "0"
    $env:DIALTONE_REPO_ROOT = $ScriptDir
    $env:DIALTONE_SRC_ROOT = Join-Path $ScriptDir "src"
    $env:GOPROXY = "off"
    $env:GOTOOLCHAIN = "local"
}

# Default DIALTONE_HOME if not set
if ([string]::IsNullOrWhiteSpace($env:DIALTONE_HOME)) {
    $env:DIALTONE_HOME = Join-Path $env:USERPROFILE ".dialtone"
}

# Default DIALTONE_ENV if not set
if ([string]::IsNullOrWhiteSpace($env:DIALTONE_ENV)) {
    $env:DIALTONE_ENV = Join-Path $env:USERPROFILE ".dialtone_env"
}

# Expand ~ in DIALTONE_HOME
if ($env:DIALTONE_HOME.StartsWith("~")) {
    $env:DIALTONE_HOME = Join-Path $env:USERPROFILE $env:DIALTONE_HOME.Substring(1).TrimStart("\/")
}

# Expand ~ in DIALTONE_ENV
if ($env:DIALTONE_ENV.StartsWith("~")) {
    $env:DIALTONE_ENV = Join-Path $env:USERPROFILE $env:DIALTONE_ENV.Substring(1).TrimStart("\/")
}

$env:GOROOT = Join-Path $env:DIALTONE_ENV "go"
$GoBin = Join-Path $env:GOROOT "bin/go.exe"
$GoToolCompile = Join-Path $env:GOROOT "pkg/tool/windows_amd64/compile.exe"
$BunBin = Join-Path $env:DIALTONE_ENV "bun/bin/bun.exe"

# Optional global log mirror: pass --stdout anywhere to mirror logs to stdout
$PassThruArgs = New-Object System.Collections.Generic.List[string]
foreach ($arg in $args) {
    if ($arg -eq "--stdout") {
        $env:DIALTONE_LOG_STDOUT = "1"
        continue
    }
    $PassThruArgs.Add($arg)
}

# 2. Resolve Go
$HasManagedGo = $false
if (-not $IsLocalCliTest) {
    try {
        $HasManagedGo = (Test-Path -LiteralPath $GoBin -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $GoToolCompile -ErrorAction SilentlyContinue)
    } catch {
        $HasManagedGo = $false
    }
}
if (-not $HasManagedGo) {
    $goCmd = Get-Command go -ErrorAction SilentlyContinue
    if ($goCmd) {
        $GoBin = $goCmd.Source
        $env:GOROOT = Split-Path -Parent (Split-Path -Parent $GoBin)
    } else {
        if ($IsLocalCliTest) {
            $ts = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
            Write-Output "$ts ERROR dialtone.ps1:759 FAIL offline guarded authorization"
            exit 1
        }
        Write-Host "DIALTONE> Go runtime missing and 'go' is not on PATH."
        Write-Host "DIALTONE> Enable Nix mode (DIALTONE_USE_NIX=1) or install managed Go into DIALTONE_ENV."
        exit 1
    }
}

# 3. Setup PATH and GOROOT
$SelectedGoBinDir = Split-Path -Parent $GoBin
$HasManagedBun = $false
if (-not $IsLocalCliTest) {
    try {
        $HasManagedBun = Test-Path -LiteralPath $BunBin -ErrorAction SilentlyContinue
    } catch {
        $HasManagedBun = $false
    }
}
if ($HasManagedBun) {
    $env:PATH = "$SelectedGoBinDir;$(Join-Path $env:DIALTONE_ENV 'bun/bin');$env:PATH"
    $env:DIALTONE_BUN_BIN = $BunBin
} else {
    if (Test-Path -LiteralPath $SelectedGoBinDir -ErrorAction SilentlyContinue) {
        $env:PATH = "$SelectedGoBinDir;$env:PATH"
    }
}
$env:DIALTONE_GO_BIN = $GoBin

# 4. Hand over to Go-based orchestrator
Push-Location -Path $env:DIALTONE_SRC_ROOT
try {
    $RunLocalWslPlugin = $PassThruArgs.Count -gt 0 -and $PassThruArgs[0] -eq "wsl" -and -not (Should-InvokeWslPluginViaShell)
    if ($RunLocalWslPlugin) {
        $PluginArgs = @()
        if ($PassThruArgs.Count -gt 1) {
            $PluginArgs = $PassThruArgs.GetRange(1, $PassThruArgs.Count - 1)
        }
        & "$GoBin" run ./plugins/wsl/scaffold/main.go $PluginArgs
    } else {
        & "$GoBin" run dev.go $PassThruArgs
    }
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $code

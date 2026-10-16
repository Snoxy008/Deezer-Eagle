# Deezer Eagle installer.
#
#   iwr -useb https://raw.githubusercontent.com/Snoxy008/Deezer-Eagle/main/install.ps1 | iex
#
# Optional environment variables:
#   DEEZER_EAGLE_REF     branch, tag or commit to install (default: main)
#   DEEZER_EAGLE_SOURCE  install from a local checkout instead of GitHub
#   DEEZER_EAGLE_HOME    install folder (default: %LOCALAPPDATA%\DeezerEagle)
#
# Kept ASCII-only, and never calls `exit`: it runs inside the user's own shell.
# Everything after the download is done by `eagle setup`.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = 'Snoxy008/Deezer-Eagle'
    $ref = 'main'
    if ($env:DEEZER_EAGLE_REF) { $ref = $env:DEEZER_EAGLE_REF }
    $eagleHome = $env:DEEZER_EAGLE_HOME
    if (-not $eagleHome) { $eagleHome = Join-Path $env:LOCALAPPDATA 'DeezerEagle' }

    Write-Host ''
    Write-Host '  Deezer Eagle - installation' -ForegroundColor Magenta

    $work = Join-Path ([IO.Path]::GetTempPath()) ('deezer-eagle-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        if ($env:DEEZER_EAGLE_SOURCE) {
            $source = (Resolve-Path -LiteralPath $env:DEEZER_EAGLE_SOURCE).ProviderPath
        } else {
            Write-Host "  -> github.com/$repo ($ref)" -ForegroundColor Cyan
            $zip = Join-Path $work 'eagle.zip'
            Invoke-WebRequest -Uri "https://github.com/$repo/archive/$ref.zip" -OutFile $zip -UseBasicParsing
            Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
            $source = (Get-ChildItem -LiteralPath $work -Directory | Select-Object -First 1).FullName
        }

        $cli = Join-Path $eagleHome 'cli'
        New-Item -ItemType Directory -Force -Path $cli | Out-Null
        Copy-Item -LiteralPath (Join-Path $source 'src/cli/eagle.ps1') -Destination (Join-Path $cli 'eagle.ps1') -Force

        # A child process, because the execution policy would block `& eagle.ps1` here.
        $shell = (Get-Process -Id $PID).Path
        if ([IO.Path]::GetFileNameWithoutExtension($shell) -notin @('powershell', 'pwsh')) { $shell = 'powershell.exe' }
        & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cli 'eagle.ps1') setup $source
        if ($LASTEXITCODE -ne 0) { Write-Host '  Installation failed, see the message above.' -ForegroundColor Red }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Lets `eagle` work right away in this window; new windows get it from the user PATH.
    $bin = Join-Path $eagleHome 'bin'
    if (($env:Path -split [IO.Path]::PathSeparator) -notcontains $bin) {
        $env:Path = $bin + [IO.Path]::PathSeparator + $env:Path
    }
}

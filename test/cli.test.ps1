# Tests for src/cli/eagle.ps1. Runs on Windows PowerShell 5.1 and PowerShell 7:
#   powershell -File test/cli.test.ps1      pwsh -File test/cli.test.ps1
# Exits with the number of failed tests.

$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('eagle-cli-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:DEEZER_EAGLE_HOME = Join-Path $tmp 'home'
$env:DEEZER_EAGLE_REGISTRY = Join-Path $root 'registry.json'
$deezer = Join-Path $tmp 'deezer'
$env:DEEZER_EAGLE_DEEZER_PATH = $deezer

. (Join-Path $root 'src/cli/eagle.ps1')

New-Item -ItemType Directory -Force -Path $script:EagleHome | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'src/core') -Destination (Join-Path $script:EagleHome 'core') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'src/template') -Destination (Join-Path $script:EagleHome 'template') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'VERSION') -Destination (Join-Path $script:EagleHome 'VERSION')

$script:failures = 0

function Check([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        Write-Host "ok - $Name" -ForegroundColor Green
    } catch {
        $script:failures++
        Write-Host "not ok - $Name" -ForegroundColor Red
        Write-Host "    $($_.Exception.Message)"
        Write-Host "    $($_.InvocationInfo.PositionMessage)"
    }
}

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw "assertion failed: $Message" }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) { throw "$Message : expected '$Expected', got '$Actual'" }
}

function Get-Bytes([string]$Text) { return , $script:Utf8.GetBytes($Text) }

function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

function New-FakeDeezer([string]$Version, [string]$Fuses) {
    $resources = Join-Path $deezer 'resources'
    New-Item -ItemType Directory -Force -Path $resources | Out-Null
    $files = [ordered]@{}
    $files['main.js'] = Get-Bytes "console.log('deezer $Version')"
    $files['package.json'] = Get-Bytes "{`"name`":`"deezer-desktop`",`"productName`":`"Deezer`",`"version`":`"$Version`",`"main`":`"main.js`",`"type`":`"commonjs`",`"build`":{`"appId`":`"x`"}}"
    Write-Asar (Join-Path $resources 'app.asar') $files
    $unpacked = Join-Path $resources 'app.asar.unpacked'
    New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
    Write-TextFile (Join-Path $unpacked 'native.node') $Version
    $exe = [byte[]](1..64) + (Get-Bytes 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX') + [byte[]](1, $Fuses.Length) + (Get-Bytes $Fuses) + [byte[]](1..16)
    [IO.File]::WriteAllBytes((Join-Path $deezer 'Deezer.exe'), [byte[]]$exe)
}

function New-ModFolder([string]$Parent, [string]$Id, [string]$Version) {
    $dir = Join-Path $Parent $Id
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-TextFile (Join-Path $dir 'manifest.json') "{`"id`":`"$Id`",`"name`":`"Mod $Id`",`"version`":`"$Version`",`"main`":`"mod.js`"}"
    Write-TextFile (Join-Path $dir 'mod.js') "mod.log('$Version')"
    return $dir
}

Check 'Write-Asar / Read-AsarEntry round trip' {
    $asar = Join-Path $tmp 'roundtrip.asar'
    $files = [ordered]@{}
    $files['a.txt'] = Get-Bytes 'hello'
    $files['empty'] = [byte[]]@()
    $files['é.json'] = Get-Bytes '{"x":"ü"}'
    Write-Asar $asar $files
    Assert-Equal 'hello' ($script:Utf8.GetString((Read-AsarEntry $asar 'a.txt'))) 'a.txt'
    Assert-Equal 0 (Read-AsarEntry $asar 'empty').Length 'empty file'
    Assert-Equal '{"x":"ü"}' ($script:Utf8.GetString((Read-AsarEntry $asar 'é.json'))) 'unicode name'
    Assert-True (-not (Test-EagleStub $asar)) 'not a stub'
    $failed = $false
    try { [void](Read-AsarEntry $asar 'missing') } catch { $failed = $true }
    Assert-True $failed 'missing entry throws'
}

Check 'Get-ElectronFuses reads the fuse wire' {
    $exe = Join-Path $tmp 'fuses.bin'
    [IO.File]::WriteAllBytes($exe, [byte[]]((Get-Bytes 'xxdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX') + [byte[]](1, 3) + (Get-Bytes '01r')))
    $fuses = Get-ElectronFuses $exe
    Assert-Equal 3 $fuses.Count 'count'
    Assert-Equal '1' $fuses[1] 'fuse 1'
    Assert-Equal 'r' $fuses[2] 'fuse 2'
    [IO.File]::WriteAllBytes($exe, [byte[]](Get-Bytes 'no sentinel'))
    Assert-True ($null -eq (Get-ElectronFuses $exe)) 'no sentinel'
}

Check 'apply patches Deezer and keeps its identity' {
    New-FakeDeezer '7.1.0' '00000000'
    $resources = Join-Path $deezer 'resources'
    $originalHash = Get-Hash (Join-Path $resources 'app.asar')
    Invoke-Apply
    $asar = Join-Path $resources 'app.asar'
    Assert-True (Test-EagleStub $asar) 'stub written'
    Assert-Equal $originalHash (Get-Hash (Join-Path $resources '_app.asar')) 'original moved intact'
    Assert-True (Test-Path (Join-Path $resources '_app.asar.unpacked/native.node')) 'unpacked moved'
    Assert-True (-not (Test-Path (Join-Path $resources 'app.asar.unpacked'))) 'old unpacked gone'
    $pkg = ConvertFrom-Json ($script:Utf8.GetString((Read-AsarEntry $asar 'package.json')))
    Assert-Equal 'deezer-desktop' $pkg.name 'name'
    Assert-Equal 'Deezer' $pkg.productName 'productName'
    Assert-Equal '7.1.0' $pkg.version 'version'
    Assert-Equal 'eagle-stub.js' $pkg.main 'main'
    Assert-True ($null -eq $pkg.PSObject.Properties['type']) 'type not copied'
    $eagle = ConvertFrom-Json ($script:Utf8.GetString((Read-AsarEntry $asar 'eagle.json')))
    Assert-Equal $script:EagleHome $eagle.home 'home'
    $stub = $script:Utf8.GetString((Read-AsarEntry $asar 'eagle-stub.js'))
    Assert-True ($stub.Contains('_app.asar')) 'stub code'
}

Check 'apply is idempotent' {
    $resources = Join-Path $deezer 'resources'
    $originalHash = Get-Hash (Join-Path $resources '_app.asar')
    Invoke-Apply
    Assert-True (Test-EagleStub (Join-Path $resources 'app.asar')) 'still a stub'
    Assert-Equal $originalHash (Get-Hash (Join-Path $resources '_app.asar')) 'original untouched'
}

Check 'apply after a Deezer update replaces the stale original' {
    $resources = Join-Path $deezer 'resources'
    Remove-Item -LiteralPath (Join-Path $resources '_app.asar.unpacked') -Recurse -Force
    New-FakeDeezer '7.2.0' '00000000'
    $newHash = Get-Hash (Join-Path $resources 'app.asar')
    Invoke-Apply
    Assert-Equal $newHash (Get-Hash (Join-Path $resources '_app.asar')) 'new original kept'
    $pkg = ConvertFrom-Json ($script:Utf8.GetString((Read-AsarEntry (Join-Path $resources 'app.asar') 'package.json')))
    Assert-Equal '7.2.0' $pkg.version 'stub follows the new version'
    Assert-Equal '7.2.0' ([IO.File]::ReadAllText((Join-Path $resources '_app.asar.unpacked/native.node'))) 'new unpacked kept'
}

Check 'restore puts the original back' {
    $resources = Join-Path $deezer 'resources'
    $originalHash = Get-Hash (Join-Path $resources '_app.asar')
    Invoke-Restore
    Assert-Equal $originalHash (Get-Hash (Join-Path $resources 'app.asar')) 'original restored'
    Assert-True (-not (Test-Path (Join-Path $resources '_app.asar'))) 'no leftover'
    Assert-True (Test-Path (Join-Path $resources 'app.asar.unpacked/native.node')) 'unpacked restored'
    Invoke-Restore
}

Check 'apply refuses when asar integrity validation is enabled' {
    Remove-Item -LiteralPath $deezer -Recurse -Force
    New-FakeDeezer '7.3.0' '00001100'
    $resources = Join-Path $deezer 'resources'
    $hash = Get-Hash (Join-Path $resources 'app.asar')
    $failed = $false
    try { Invoke-Apply } catch { $failed = $_.Exception.Message -like "*integrity*" }
    Assert-True $failed 'refused with an explanation'
    Assert-Equal $hash (Get-Hash (Join-Path $resources 'app.asar')) 'nothing modified'
    Assert-True (-not (Test-Path (Join-Path $resources '_app.asar'))) 'no backup created'
}

Check 'Resolve-ModSpec understands every source format' {
    $spec = Resolve-ModSpec 'someone/cool-mod'
    Assert-Equal 'someone/cool-mod' $spec.repo 'owner/repo'
    Assert-Equal '' $spec.path 'no path'
    $spec = Resolve-ModSpec 'someone/mods/themes/dark@v2'
    Assert-Equal 'someone/mods' $spec.repo 'repo with path'
    Assert-Equal 'themes/dark' $spec.path 'path'
    Assert-Equal 'v2' $spec.ref 'ref'
    $spec = Resolve-ModSpec 'https://github.com/someone/cool-mod.git'
    Assert-Equal 'someone/cool-mod' $spec.repo 'git url'
    $spec = Resolve-ModSpec 'https://github.com/someone/mods/tree/main/themes/dark'
    Assert-Equal 'themes/dark' $spec.path 'tree url path'
    Assert-Equal 'main' $spec.ref 'tree url ref'
    $spec = Resolve-ModSpec 'adblock'
    Assert-Equal 'Snoxy008/Deezer-Eagle' $spec.repo 'registry repo'
    Assert-Equal 'mods/adblock' $spec.path 'registry path'
    $spec = Resolve-ModSpec $root
    Assert-Equal 'local' $spec.type 'local folder'
    $failed = $false
    try { [void](Resolve-ModSpec 'definitely-not-a-mod') } catch { $failed = $true }
    Assert-True $failed 'unknown id throws'
    $failed = $false
    try { [void](Resolve-ModSpec '.\missing-folder') } catch { $failed = $_.Exception.Message -like 'Folder not found*' }
    Assert-True $failed 'missing local folder is not sent to GitHub'
    # Installs asked by the library never read local folders, even existing ones.
    Push-Location $root
    try {
        $spec = Resolve-ModSpec 'mods/adblock' $true
        Assert-Equal 'github' $spec.type 'remote only: owner/repo stays on GitHub'
        Assert-Equal 'mods/adblock' $spec.repo 'remote only: repo'
        $failed = $false
        try { [void](Resolve-ModSpec $root $true) } catch { $failed = $true }
        Assert-True $failed 'remote only: absolute folder refused'
    } finally {
        Pop-Location
    }
}

Check 'install, disable, enable, update and remove a local mod' {
    $src = New-ModFolder (Join-Path $tmp 'src') 'demo' '1.0.0'
    Invoke-Install @($src) $true
    $mod = Get-Mod 'demo'
    Assert-Equal '1.0.0' $mod.Version 'installed'
    Assert-True $mod.Enabled 'enabled by default'
    Assert-Equal 'local' $mod.Source.type 'source recorded'

    Invoke-Toggle @('demo') $false
    Assert-True (-not (Get-Mod 'demo').Enabled) 'disabled'
    $config = Read-Json $script:ConfigFile
    Assert-Equal 'demo' (@($config.disabled) -join ',') 'disabled list is a JSON array'

    [void](New-ModFolder (Join-Path $tmp 'src') 'demo' '1.1.0')
    Invoke-Update @()
    Assert-Equal '1.1.0' (Get-Mod 'demo').Version 'updated'
    Assert-True (-not (Get-Mod 'demo').Enabled) 'update keeps it disabled'

    Invoke-Toggle @('demo') $true
    Assert-True (Get-Mod 'demo').Enabled 're-enabled'

    Invoke-Remove @('demo')
    Assert-Equal 0 @(Get-Mods | Where-Object { $_.Id -eq 'demo' }).Count 'removed'
}

Check 'install rejects invalid manifests' {
    $dir = Join-Path $tmp 'bad'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-TextFile (Join-Path $dir 'manifest.json') '{"id":"Bad","name":"x","version":"1"}'
    $failed = $false
    try { Invoke-Install @($dir) $true } catch { $failed = $true }
    Assert-True $failed 'uppercase id refused'
}

Check 'new scaffolds a linked mod; remove keeps the sources' {
    $work = Join-Path $tmp 'work'
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Push-Location $work
    try { Invoke-New 'my-theme' } finally { Pop-Location }
    $dir = Join-Path $work 'my-theme'
    $manifest = Read-Json (Join-Path $dir 'manifest.json')
    Assert-Equal 'my-theme' $manifest.id 'id substituted'
    Assert-Equal 'My Theme' $manifest.name 'name derived'
    $mod = Get-Mod 'my-theme'
    Assert-True $mod.Linked 'linked'
    Write-TextFile (Join-Path $dir 'style.css') 'body{}'
    Assert-Equal 'body{}' ([IO.File]::ReadAllText((Join-Path $script:ModsDir 'my-theme/style.css'))) 'link shows live edits'
    Invoke-Remove @('my-theme')
    Assert-True (Test-Path (Join-Path $dir 'mod.js')) 'sources kept'
    Assert-True (-not (Test-Path (Join-Path $script:ModsDir 'my-theme'))) 'link removed'
}

Check 'config devtools and deezerPath' {
    Invoke-Config @('devtools', 'on')
    Assert-True ((Get-Config).devtools -eq $true) 'devtools on'
    Invoke-Config @('devtools', 'off')
    Assert-True ((Get-Config).devtools -eq $false) 'devtools off'
    Invoke-Config @('deezerPath', $deezer)
    Assert-Equal (Get-FullPath $deezer) (Get-Config).deezerPath 'deezerPath'
}

Check 'setup installs the CLI, default mods and the shim' {
    $env:DEEZER_EAGLE_HOME = Join-Path $tmp 'fresh'
    $shell = (Get-Process -Id $PID).Path
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'src/cli/eagle.ps1') setup $root --no-apply | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'exit code'
    $fresh = $env:DEEZER_EAGLE_HOME
    foreach ($file in @('cli/eagle.ps1', 'core/main.js', 'core/stub/index.js', 'template/manifest.json', 'bin/eagle.cmd', 'VERSION', 'config.json', 'user.css')) {
        Assert-True (Test-Path (Join-Path $fresh $file)) $file
    }
    Assert-True (Test-Path (Join-Path $fresh 'mods/adblock/manifest.json')) 'adblock installed'
    Assert-True (Test-Path (Join-Path $fresh 'mods/no-tracking/manifest.json')) 'no-tracking installed'
    Assert-True (-not (Test-Path (Join-Path $fresh 'mods/copy-link'))) 'optional mod not installed'
    $source = Read-Json (Join-Path $fresh 'mods/adblock/.eagle-source.json')
    Assert-Equal 'Snoxy008/Deezer-Eagle' $source.repo 'built-in source'
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fresh 'cli/eagle.ps1') version | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'installed CLI runs'
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fresh 'cli/eagle.ps1') nope 2>&1 | Out-Null
    Assert-Equal 1 $LASTEXITCODE 'unknown command fails'
}

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($script:failures -eq 0) { Write-Host 'All tests passed.' -ForegroundColor Green }
else { Write-Host "$($script:failures) test(s) failed." -ForegroundColor Red }
exit $script:failures

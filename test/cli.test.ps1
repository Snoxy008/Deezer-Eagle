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

# Builds an archive the way @electron/asar does; names may contain folders.
function New-TestAsar([string]$Path, $Files) {
    $root = [ordered]@{}
    $offset = 0
    $data = New-Object IO.MemoryStream
    foreach ($name in $Files.Keys) {
        $bytes = [byte[]]$Files[$name]
        $node = $root
        $parts = $name.Split('/')
        for ($i = 0; $i -lt $parts.Count - 1; $i++) {
            if (-not $node.Contains($parts[$i])) { $node[$parts[$i]] = [ordered]@{ files = [ordered]@{} } }
            $node = $node[$parts[$i]]['files']
        }
        $node[$parts[-1]] = [ordered]@{ size = $bytes.Length; offset = [string]$offset }
        $data.Write($bytes, 0, $bytes.Length)
        $offset += $bytes.Length
    }
    $header = ConvertTo-AsarHeaderBytes (ConvertTo-Json -InputObject ([ordered]@{ files = $root }) -Depth 30 -Compress)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create)
    try {
        $stream.Write($header, 0, $header.Length)
        $data.WriteTo($stream)
    } finally {
        $stream.Dispose()
    }
}

function New-FakeDeezer([string]$Version, [string]$Fuses) {
    $resources = Join-Path $deezer 'resources'
    New-Item -ItemType Directory -Force -Path $resources | Out-Null
    $files = [ordered]@{}
    $files['package.json'] = Get-Bytes "{`"name`":`"deezer-desktop`",`"productName`":`"Deezer`",`"version`":`"$Version`",`"main`":`"./build/main.js`"}"
    $files['build/index.html'] = Get-Bytes '<div id="dzr-app"></div>'
    $files['build/main.js'] = Get-Bytes "'use strict';`nconsole.log('deezer $Version');`n"
    $files['node_modules/lib/main.js'] = Get-Bytes 'module.exports = "same name, other file";'
    New-TestAsar (Join-Path $resources 'app.asar') $files
    $unpacked = Join-Path $resources 'app.asar.unpacked'
    New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
    Write-TextFile (Join-Path $unpacked 'native.node') $Version
    $exe = [byte[]](1..64) + (Get-Bytes 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX') + [byte[]](1, $Fuses.Length) + (Get-Bytes $Fuses) + [byte[]](1..16)
    [IO.File]::WriteAllBytes((Join-Path $deezer 'Deezer.exe'), [byte[]]$exe)
}

function Read-Text([string]$Asar, [string]$Name) { return $script:Utf8.GetString((Read-AsarEntry $Asar $Name)) }

# "path|size|offset" for every file of a parsed archive header, sorted.
function Get-AsarFileList($Node, [string]$Prefix) {
    $entries = foreach ($name in $Node['files'].Keys) {
        $child = $Node['files'][$name]
        if ($child.Keys -contains 'files') { Get-AsarFileList $child "$Prefix$name/" }
        else { "$Prefix$name|$($child['size'])|$($child['offset'])" }
    }
    return @($entries | Sort-Object)
}

function New-ModFolder([string]$Parent, [string]$Id, [string]$Version) {
    $dir = Join-Path $Parent $Id
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-TextFile (Join-Path $dir 'manifest.json') "{`"id`":`"$Id`",`"name`":`"Mod $Id`",`"version`":`"$Version`",`"main`":`"mod.js`"}"
    Write-TextFile (Join-Path $dir 'mod.js') "mod.log('$Version')"
    return $dir
}

Check 'archives are read by path, folders included' {
    $asar = Join-Path $tmp 'read.asar'
    $files = [ordered]@{}
    $files['a.txt'] = Get-Bytes 'hello'
    $files['empty'] = [byte[]]@()
    $files['dir/sub/é.json'] = Get-Bytes '{"x":"ü"}'
    New-TestAsar $asar $files
    Assert-Equal 'hello' (Read-Text $asar 'a.txt') 'a.txt'
    Assert-Equal 0 (Read-AsarEntry $asar 'empty').Length 'empty file'
    Assert-Equal '{"x":"ü"}' (Read-Text $asar 'dir/sub/é.json') 'nested unicode name'
    Assert-Equal 'original' (Get-PatchState $asar) 'not patched'
    $failed = $false
    try { [void](Read-AsarEntry $asar 'dir/missing') } catch { $failed = $true }
    Assert-True $failed 'missing entry throws'
}

Check 'the loader goes after what must stay first in a script' {
    $loader = '/* Deezer Eagle loader */ ;load();'
    Assert-Equal "'use strict';`n$loader`nrun();" (Add-EagleLoader "'use strict';run();" $loader) 'after "use strict"'
    Assert-Equal "/*! license */`n`"use strict`"`n$loader`n`nrun()" (Add-EagleLoader "/*! license */`n`"use strict`"`nrun()" $loader) 'after comments and a directive without semicolon'
    Assert-Equal "#!/usr/bin/env node`n`n$loader`nrun()" (Add-EagleLoader "#!/usr/bin/env node`nrun()" $loader) 'after a #! line'
    Assert-Equal "`n$loader`n(() => {`"use strict`"})()" (Add-EagleLoader '(() => {"use strict"})()' $loader) 'a bundle: at the very top'
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

Check 'apply modifies Deezer''s own archive in place' {
    New-FakeDeezer '7.1.0' '00000000'
    $resources = Join-Path $deezer 'resources'
    $asar = Join-Path $resources 'app.asar'
    $originalHash = Get-Hash $asar
    $originalHeader = (Read-AsarHeader $asar).Json
    Invoke-Apply
    Assert-Equal 'patched' (Get-PatchState $asar) 'patched'
    $backup = Join-Path $script:EagleHome 'backup/app.asar'
    Assert-Equal $originalHash (Get-Hash $backup) 'untouched backup in the Eagle folder'
    Assert-True (-not (Test-Path (Join-Path $resources '_app.asar'))) 'no second archive in Deezer'
    Assert-True (-not (Test-Path (Join-Path $resources 'app.asar.eagle'))) 'no leftover'
    Assert-True (Test-Path (Join-Path $resources 'app.asar.unpacked/native.node')) 'unpacked files untouched'
    Assert-Equal "{`"name`":`"deezer-desktop`",`"productName`":`"Deezer`",`"version`":`"7.1.0`",`"main`":`"./build/main.js`"}" (Read-Text $asar 'package.json') 'package.json untouched'
    Assert-Equal '<div id="dzr-app"></div>' (Read-Text $asar 'build/index.html') 'other files untouched'
    Assert-Equal 'module.exports = "same name, other file";' (Read-Text $asar 'node_modules/lib/main.js') 'a file with the same name untouched'
    $main = Read-Text $asar 'build/main.js'
    Assert-True ($main.StartsWith("'use strict';`n/* Deezer Eagle loader")) 'loader right after "use strict"'
    Assert-True ($main.EndsWith("`nconsole.log('deezer 7.1.0');`n")) 'Deezer''s code follows'
    Assert-True ($main.Contains((ConvertTo-Json -InputObject $script:EagleHome -Compress))) 'loader points to the Eagle folder'
    $marker = ConvertFrom-Json (Read-Text $asar 'eagle.json')
    Assert-Equal 'build/main.js' $marker.entry 'marker names the patched script'
    $node = Get-AsarNode (ConvertFrom-JsonDictionary (Read-AsarHeader $asar).Json) 'build/main.js'
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash((Read-AsarEntry $asar 'build/main.js'))).Replace('-', '').ToLowerInvariant()
    Assert-Equal $hash $node['integrity']['hash'] 'integrity updated'
    $before = @(Get-AsarFileList (ConvertFrom-JsonDictionary $originalHeader) '' | Where-Object { $_ -notlike 'build/main.js|*' })
    $after = @(Get-AsarFileList (ConvertFrom-JsonDictionary (Read-AsarHeader $asar).Json) '' | Where-Object { $_ -notlike 'build/main.js|*' -and $_ -notlike 'eagle.json|*' })
    Assert-Equal ($before -join ';') ($after -join ';') 'every other entry unchanged'
}

Check 'apply is idempotent' {
    $asar = Join-Path $deezer 'resources/app.asar'
    $backup = Join-Path $script:EagleHome 'backup/app.asar'
    $backupHash = Get-Hash $backup
    Invoke-Apply
    Assert-Equal 'patched' (Get-PatchState $asar) 'still patched'
    Assert-Equal 1 ([regex]::Matches((Read-Text $asar 'build/main.js'), 'Deezer Eagle loader').Count) 'one loader only'
    Assert-Equal $backupHash (Get-Hash $backup) 'backup untouched'
}

Check 'apply after a Deezer update patches the new version' {
    New-FakeDeezer '7.2.0' '00000000'
    $asar = Join-Path $deezer 'resources/app.asar'
    $newHash = Get-Hash $asar
    Invoke-Apply
    Assert-Equal $newHash (Get-Hash (Join-Path $script:EagleHome 'backup/app.asar')) 'backup follows the new version'
    Assert-True ((Read-Text $asar 'build/main.js').Contains("console.log('deezer 7.2.0')")) 'new Deezer code'
}

Check 'restore puts the original back' {
    $asar = Join-Path $deezer 'resources/app.asar'
    $originalHash = Get-Hash (Join-Path $script:EagleHome 'backup/app.asar')
    Invoke-Restore
    Assert-Equal $originalHash (Get-Hash $asar) 'original restored byte for byte'
    Assert-True (-not (Test-Path (Join-Path $script:EagleHome 'backup'))) 'backup removed'
    Assert-Equal 'original' (Get-PatchState $asar) 'not patched'
    Invoke-Restore
}

Check 'apply moves an Eagle 1.0 install to the new patch' {
    Remove-Item -LiteralPath $deezer -Recurse -Force
    New-FakeDeezer '7.3.0' '00000000'
    $resources = Join-Path $deezer 'resources'
    $asar = Join-Path $resources 'app.asar'
    $originalHash = Get-Hash $asar
    Move-Item -LiteralPath $asar -Destination (Join-Path $resources '_app.asar')
    Move-Item -LiteralPath (Join-Path $resources 'app.asar.unpacked') -Destination (Join-Path $resources '_app.asar.unpacked')
    $stub = [ordered]@{}
    $stub['eagle-stub.js'] = Get-Bytes '// old loader'
    $stub['eagle.json'] = Get-Bytes '{}'
    $stub['package.json'] = Get-Bytes '{"name":"deezer-desktop","main":"eagle-stub.js"}'
    New-TestAsar $asar $stub
    Assert-Equal 'legacy' (Get-PatchState $asar) 'old layout detected'
    Invoke-Apply
    Assert-Equal 'patched' (Get-PatchState $asar) 'patched the new way'
    Assert-True (-not (Test-Path (Join-Path $resources '_app.asar'))) 'old copy gone'
    Assert-True (Test-Path (Join-Path $resources 'app.asar.unpacked/native.node')) 'unpacked files back in place'
    Assert-Equal $originalHash (Get-Hash (Join-Path $script:EagleHome 'backup/app.asar')) 'backup is Deezer''s original'
    Invoke-Restore
    Assert-Equal $originalHash (Get-Hash $asar) 'restore gives the original back'
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
    Assert-Equal 'original' (Get-PatchState (Join-Path $resources 'app.asar')) 'not patched'
    Assert-True (-not (Test-Path (Join-Path $script:EagleHome 'backup'))) 'no backup created'
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
    foreach ($file in @('cli/eagle.ps1', 'core/main.js', 'core/loader.js', 'template/manifest.json', 'bin/eagle.cmd', 'VERSION', 'config.json', 'user.css')) {
        Assert-True (Test-Path (Join-Path $fresh $file)) $file
    }
    foreach ($id in @('adblock', 'no-tracking', 'volume-wheel', 'midnight', 'nord', 'rose-pine-dawn')) {
        Assert-True (Test-Path (Join-Path $fresh "mods/$id/manifest.json")) "$id installed by default"
    }
    Assert-True (-not (Test-Path (Join-Path $fresh 'mods/copy-link'))) 'optional mod not installed'
    $offered = @((Read-Json (Join-Path $fresh 'config.json')).installedDefaults)
    Assert-True ($offered -contains 'nord' -and $offered -contains 'adblock') 'defaults remembered'
    $source = Read-Json (Join-Path $fresh 'mods/adblock/.eagle-source.json')
    Assert-Equal 'Snoxy008/Deezer-Eagle' $source.repo 'built-in source'
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fresh 'cli/eagle.ps1') version | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'installed CLI runs'
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fresh 'cli/eagle.ps1') nope 2>&1 | Out-Null
    Assert-Equal 1 $LASTEXITCODE 'unknown command fails'
}

Check 'upgrading from 0.2 adds the new defaults but not removed ones' {
    $env:DEEZER_EAGLE_HOME = Join-Path $tmp 'old'
    $old = $env:DEEZER_EAGLE_HOME
    New-Item -ItemType Directory -Force -Path (Join-Path $old 'mods') | Out-Null
    Write-TextFile (Join-Path $old 'config.json') '{"disabled":[],"devtools":false,"deezerPath":""}'
    $shell = (Get-Process -Id $PID).Path
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'src/cli/eagle.ps1') setup $root --no-apply | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'exit code'
    Assert-True (-not (Test-Path (Join-Path $old 'mods/adblock'))) 'adblock was removed by the user: stays removed'
    Assert-True (Test-Path (Join-Path $old 'mods/nord/manifest.json')) 'new default theme installed'
    Assert-True (Test-Path (Join-Path $old 'mods/volume-wheel/manifest.json')) 'new default mod installed'
    Remove-Item -LiteralPath (Join-Path $old 'mods/nord') -Recurse -Force
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'src/cli/eagle.ps1') setup $root --no-apply | Out-Null
    Assert-True (-not (Test-Path (Join-Path $old 'mods/nord'))) 'a removed default is not installed again'
}

Check 'theme lists and switches themes' {
    $env:DEEZER_EAGLE_HOME = Join-Path $tmp 'fresh'
    $script:EagleHome = $env:DEEZER_EAGLE_HOME
    $script:ModsDir = Join-Path $script:EagleHome 'mods'
    $script:ConfigFile = Join-Path $script:EagleHome 'config.json'
    Invoke-Theme ''
    Invoke-Theme 'nord'
    Assert-Equal 'nord' (Get-Config).theme 'theme set'
    Assert-Equal 'theme' (Get-Mod 'nord').Type 'type read from the manifest'
    Assert-Equal 'mod' (Get-Mod 'adblock').Type 'mods are mods'
    $failed = $false
    try { Invoke-Theme 'adblock' } catch { $failed = $true }
    Assert-True $failed 'a mod is not a theme'
    Invoke-Theme 'none'
    Assert-True ($null -eq (Get-Config).theme) 'back to Deezer colours'
}

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($script:failures -eq 0) { Write-Host 'All tests passed.' -ForegroundColor Green }
else { Write-Host "$($script:failures) test(s) failed." -ForegroundColor Red }
exit $script:failures

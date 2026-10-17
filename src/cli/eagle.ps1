# Deezer Eagle - command line interface (`eagle help` for usage).
#
# Must keep working on Windows PowerShell 5.1: no ternaries, no `??`,
# no ConvertFrom-Json -AsHashtable. Saved as UTF-8 with BOM so 5.1 reads
# any non-ASCII text correctly.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$script:Repo = 'Snoxy008/Deezer-Eagle'
$script:Branch = 'main'
$script:Topic = 'deezer-eagle-mod'
$script:OnWindows = $env:OS -eq 'Windows_NT'
$script:Utf8 = New-Object System.Text.UTF8Encoding $false

if ($env:DEEZER_EAGLE_HOME) {
    $script:EagleHome = $env:DEEZER_EAGLE_HOME
} else {
    $script:EagleHome = Join-Path $env:LOCALAPPDATA 'DeezerEagle'
}
$script:ModsDir = Join-Path $script:EagleHome 'mods'
$script:ConfigFile = Join-Path $script:EagleHome 'config.json'
$script:UserCss = Join-Path $script:EagleHome 'user.css'

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Write-Step([string]$Text) { Write-Host "  -> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  OK $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  !! $Text" -ForegroundColor Yellow }
function Write-Reload { Write-Host '  Reload Deezer (Ctrl+Shift+R) or restart it to apply.' -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# Files and JSON
# ---------------------------------------------------------------------------

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $text = [IO.File]::ReadAllText($Path)
    if (-not $text.Trim()) { return $null }
    return ConvertFrom-Json -InputObject $text
}

function ConvertTo-JsonText($Value) {
    return ConvertTo-Json -InputObject $Value -Depth 20
}

function Write-TextFile([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, $script:Utf8)
}

function Write-Json([string]$Path, $Value) {
    Write-TextFile $Path (ConvertTo-JsonText $Value)
}

function New-TempDir {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('deezer-eagle-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    return $dir
}

function Get-FullPath([string]$Path) {
    return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Invoke-Download([string]$Url, [string]$OutFile) {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers @{ 'User-Agent' = 'Deezer-Eagle' }
}

function Get-EagleVersion {
    $file = Join-Path $script:EagleHome 'VERSION'
    if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file)).Trim() }
    return 'dev'
}

# Deserializes JSON into dictionaries; unlike ConvertFrom-Json on 5.1 it has
# no size limit and keeps the archive's file names as plain keys.
function ConvertFrom-JsonDictionary([string]$Json) {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return ConvertFrom-Json -InputObject $Json -AsHashtable
    }
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    $serializer.RecursionLimit = 1000
    return $serializer.DeserializeObject($Json)
}

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

function Get-Config {
    $config = [ordered]@{ disabled = @(); devtools = $false; deezerPath = ''; theme = $null }
    $raw = $null
    try { $raw = Read-Json $script:ConfigFile } catch { Write-Warn 'config.json is unreadable, using defaults.' }
    if ($raw) {
        foreach ($property in $raw.PSObject.Properties) { $config[$property.Name] = $property.Value }
    }
    $config.disabled = @($config.disabled | Where-Object { $_ })
    return $config
}

function Save-Config($Config) {
    New-Item -ItemType Directory -Force -Path $script:EagleHome | Out-Null
    Write-Json $script:ConfigFile $Config
}

# ---------------------------------------------------------------------------
# ASAR archives (Electron's app bundle format)
#
# Layout: [uint32 4][uint32 headerSize] then a Chromium pickle of headerSize
# bytes: [uint32 payloadSize][int32 jsonLength][json][padding to 4 bytes].
# File contents follow; their offsets are relative to 8 + headerSize.
# ---------------------------------------------------------------------------

# Shared read: an antivirus or indexer holding the archive must not block us.
function Open-SharedRead([string]$Path) {
    return [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
}

function Read-AsarHeader([string]$Path) {
    $stream = Open-SharedRead $Path
    try {
        $reader = New-Object IO.BinaryReader $stream
        $sizePickle = $reader.ReadUInt32()
        $headerSize = $reader.ReadUInt32()
        [void]$reader.ReadUInt32()
        $jsonLength = $reader.ReadInt32()
        if ($sizePickle -ne 4 -or $jsonLength -le 0 -or $jsonLength -gt $headerSize) {
            throw "Invalid asar archive: $Path"
        }
        $json = $script:Utf8.GetString($reader.ReadBytes($jsonLength))
        return [pscustomobject]@{ Json = $json; DataOffset = 8 + [int64]$headerSize }
    } finally {
        $stream.Dispose()
    }
}

# A key of a parsed header node, or $null: on Windows PowerShell 5.1 the nodes
# are .NET dictionaries, which may throw on a missing key.
function Get-Key($Node, [string]$Key) {
    if ($Node -and $Node.Keys -contains $Key) { return $Node[$Key] }
    return $null
}

# Finds a file or folder in a parsed header ("build/main.js"), or $null.
function Get-AsarNode($Tree, [string]$Name) {
    $node = $Tree
    foreach ($part in $Name.Split('/')) {
        $files = Get-Key $node 'files'
        if (-not $files -or -not ($files.Keys -contains $part)) { return $null }
        $node = $files[$part]
    }
    return $node
}

function Read-AsarBytes([string]$Path, [int64]$DataOffset, $Node) {
    $offset = [int64]$Node['offset']
    $size = [int]$Node['size']
    $stream = Open-SharedRead $Path
    try {
        [void]$stream.Seek($DataOffset + $offset, [IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] $size
        $read = 0
        while ($read -lt $size) {
            $count = $stream.Read($buffer, $read, $size - $read)
            if ($count -le 0) { throw "Truncated asar archive: $Path" }
            $read += $count
        }
        return , $buffer
    } finally {
        $stream.Dispose()
    }
}

function Read-AsarEntry([string]$Path, [string]$Name) {
    $header = Read-AsarHeader $Path
    $node = Get-AsarNode (ConvertFrom-JsonDictionary $header.Json) $Name
    if ($null -eq (Get-Key $node 'offset')) { throw "$Name not found in $Path" }
    return , (Read-AsarBytes $Path $header.DataOffset $node)
}

# The header of an archive: the size pickle, then the pickle holding the JSON.
function ConvertTo-AsarHeaderBytes([string]$Json) {
    $bytes = $script:Utf8.GetBytes($Json)
    $padding = (4 - ($bytes.Length % 4)) % 4
    $payloadSize = 4 + $bytes.Length + $padding
    $stream = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter $stream
    $writer.Write([uint32]4)
    $writer.Write([uint32](4 + $payloadSize))
    $writer.Write([uint32]$payloadSize)
    $writer.Write([int32]$bytes.Length)
    $writer.Write($bytes)
    $writer.Write((New-Object byte[] $padding))
    $writer.Flush()
    return , $stream.ToArray()
}

# The "integrity" Electron can check: SHA-256 of the file and of 4 MB blocks.
function Get-AsarIntegrity([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $hex = { param([byte[]]$Hash) [BitConverter]::ToString($Hash).Replace('-', '').ToLowerInvariant() }
    $blockSize = 4MB
    $blocks = @()
    for ($start = 0; $start -lt $Bytes.Length; $start += $blockSize) {
        $blocks += '"' + (& $hex ($sha.ComputeHash($Bytes, $start, [Math]::Min($blockSize, $Bytes.Length - $start)))) + '"'
    }
    return '{{"algorithm":"SHA256","hash":"{0}","blockSize":{1},"blocks":[{2}]}}' -f (& $hex ($sha.ComputeHash($Bytes))), $blockSize, ($blocks -join ',')
}

# Index of the "}" closing the JSON object that starts at $Start.
function Get-JsonObjectEnd([string]$Json, [int]$Start) {
    $depth = 0
    $inString = $false
    for ($i = $Start; $i -lt $Json.Length; $i++) {
        $char = $Json[$i]
        if ($inString) {
            if ($char -eq '\') { $i++ } elseif ($char -eq '"') { $inString = $false }
        } elseif ($char -eq '"') {
            $inString = $true
        } elseif ($char -eq '{') {
            $depth++
        } elseif ($char -eq '}') {
            $depth--
            if ($depth -eq 0) { return $i }
        }
    }
    throw 'Invalid asar header.'
}

# Swaps the header entry of one file (found by name and offset) for $EntryJson,
# leaving the rest of the header text untouched.
function Set-AsarEntryJson([string]$Json, [string]$Name, [string]$Offset, [string]$EntryJson) {
    foreach ($match in [regex]::Matches($Json, '"' + [regex]::Escape($Name) + '"\s*:\s*\{')) {
        $start = $match.Index + $match.Length - 1
        $end = Get-JsonObjectEnd $Json $start
        $object = $Json.Substring($start, $end - $start + 1)
        if ($object -match '^\{\s*"files"' -or $object -notmatch ('"offset"\s*:\s*"' + $Offset + '"')) { continue }
        return $Json.Substring(0, $start) + $EntryJson + $Json.Substring($end + 1)
    }
    throw "$Name was not found in the archive header."
}

function Add-AsarRootEntryJson([string]$Json, [string]$Name, [string]$EntryJson) {
    $match = [regex]::Match($Json, '^\{\s*"files"\s*:\s*\{')
    if (-not $match.Success) { throw 'Unexpected asar header.' }
    $rest = $Json.Substring($match.Length)
    $separator = ','
    if ($rest -match '^\s*\}') { $separator = '' }
    return $Json.Substring(0, $match.Length) + '"' + $Name + '":' + $EntryJson + $separator + $rest
}

$script:LoaderMarker = '/* Deezer Eagle loader'

# Puts the loader at the top of Deezer's entry script: after a BOM, a #! line,
# leading comments and a "use strict" directive, which must stay first.
function Add-EagleLoader([string]$Code, [string]$Loader) {
    $match = [regex]::Match($Code, '^﻿?(?:#![^\n]*\n)?(?:\s+|//[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)*(?:([''"])use strict\1;?)?')
    return $Code.Substring(0, $match.Length) + "`n" + $Loader.Trim() + "`n" + $Code.Substring($match.Length)
}

function Get-PatchState([string]$Asar) {
    if (-not (Test-Path -LiteralPath $Asar -PathType Leaf)) { return 'missing' }
    try { $header = Read-AsarHeader $Asar } catch { return 'invalid' }
    if (-not $header.Json.Contains('"eagle.json"')) { return 'original' }
    try { $files = Get-Key (ConvertFrom-JsonDictionary $header.Json) 'files' } catch { return 'invalid' }
    if (-not $files) { return 'invalid' }
    if ($files.Keys -contains 'eagle-stub.js') { return 'legacy' }
    if ($files.Keys -contains 'eagle.json') { return 'patched' }
    return 'original'
}

# Electron fuses live right after a sentinel string in the executable:
# [version byte][fuse count][one byte per fuse: '0' off, '1' on, 'r' removed].
function Get-ElectronFuses([string]$Exe) {
    $bytes = [IO.File]::ReadAllBytes($Exe)
    $text = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $index = $text.IndexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', [StringComparison]::Ordinal)
    if ($index -lt 0) { return $null }
    $position = $index + 32
    $count = $bytes[$position + 1]
    $fuses = @()
    for ($i = 0; $i -lt $count; $i++) { $fuses += [string][char]$bytes[$position + 2 + $i] }
    return , $fuses
}

# ---------------------------------------------------------------------------
# Deezer installation
# ---------------------------------------------------------------------------

function Find-Deezer {
    $config = Get-Config
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:DEEZER_EAGLE_DEEZER_PATH) { $candidates.Add($env:DEEZER_EAGLE_DEEZER_PATH) }
    if ($config.deezerPath) { $candidates.Add([string]$config.deezerPath) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\deezer-desktop')) }
    if ($script:OnWindows) {
        $keys = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        foreach ($entry in (Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)) {
            if ($entry.PSObject.Properties['DisplayName'] -and $entry.DisplayName -like 'Deezer*') {
                if ($entry.PSObject.Properties['InstallLocation'] -and $entry.InstallLocation) {
                    $candidates.Add($entry.InstallLocation.Trim('"'))
                } elseif ($entry.PSObject.Properties['DisplayIcon'] -and $entry.DisplayIcon) {
                    $candidates.Add((Split-Path -Parent ($entry.DisplayIcon -split ',')[0].Trim('"')))
                }
            }
        }
        foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if ($root) { $candidates.Add((Join-Path $root 'Deezer')) }
        }
    }
    foreach ($dir in $candidates) {
        if (-not $dir) { continue }
        $resources = Join-Path $dir 'resources'
        if ((Test-Path -LiteralPath (Join-Path $resources 'app.asar')) -or (Test-Path -LiteralPath (Join-Path $resources '_app.asar'))) {
            $full = Get-FullPath $dir
            if ($full -like '*\WindowsApps\*') {
                throw 'The Microsoft Store version of Deezer cannot be modified. Install the regular version from https://www.deezer.com/download'
            }
            return $full
        }
    }
    return $null
}

function Get-DeezerOrFail {
    $dir = Find-Deezer
    if (-not $dir) {
        throw 'Deezer Desktop not found. Install it from https://www.deezer.com/download (not the Microsoft Store version), or tell Eagle where it is: eagle config deezerPath <folder>'
    }
    return $dir
}

function Get-DeezerExe([string]$Dir) {
    $exe = Join-Path $Dir 'Deezer.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    # Elsewhere (tests, renamed builds) the Electron binary is the largest file.
    $largest = Get-ChildItem -LiteralPath $Dir -File | Sort-Object Length -Descending | Select-Object -First 1
    if ($largest) { return $largest.FullName }
    return $null
}

function Get-DeezerProcesses([string]$Dir) {
    $prefix = $Dir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $processPath = $null
        try { $processPath = $_.Path } catch { }
        $processPath -and $processPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Stop-Deezer([string]$Dir) {
    $processes = Get-DeezerProcesses $Dir
    if ($processes.Count -eq 0) { return $false }
    Write-Step 'Closing Deezer...'
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 50 -and (Get-DeezerProcesses $Dir).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 500
    return $true
}

function Start-Deezer([string]$Dir) {
    $exe = Get-DeezerExe $Dir
    if ($exe) {
        Write-Step 'Starting Deezer...'
        Start-Process -FilePath $exe
    }
}

function Get-PatchPaths([string]$Dir) {
    $resources = Join-Path $Dir 'resources'
    return [pscustomobject]@{
        Asar = Join-Path $resources 'app.asar'
        Unpacked = Join-Path $resources 'app.asar.unpacked'
        Building = Join-Path $resources 'app.asar.eagle'
        Backup = Join-Path $script:EagleHome 'backup/app.asar'
        # Before 1.1, Eagle moved Deezer's archive to _app.asar and put a loader in its place.
        Legacy = Join-Path $resources '_app.asar'
        LegacyUnpacked = Join-Path $resources '_app.asar.unpacked'
    }
}

# Writes to $Target a copy of Deezer's archive $Source where Deezer's entry
# script starts with the Eagle loader. The new script and an eagle.json marker
# are appended after the original data and only their header entries change,
# so every other file of Deezer stays byte for byte the same.
function New-PatchedArchive([string]$Source, [string]$Target) {
    $header = Read-AsarHeader $Source
    $tree = ConvertFrom-JsonDictionary $header.Json
    $pkg = ConvertFrom-Json -InputObject ($script:Utf8.GetString((Read-AsarEntry $Source 'package.json')).TrimStart([char]0xFEFF))
    $main = (([string]$pkg.main) -replace '\\', '/') -replace '^\./', ''
    if (-not $main) { $main = 'index.js' }
    $entry = $null
    foreach ($candidate in @($main, "$main.js", "$main/index.js")) {
        $node = Get-AsarNode $tree $candidate
        if ($null -ne (Get-Key $node 'offset')) { $entry = $candidate; break }
    }
    if (-not $entry) { throw "Deezer's entry script ($main) is not in app.asar. Nothing was changed." }
    if ($pkg.type -eq 'module' -or $entry -like '*.mjs') {
        throw 'This version of Deezer is an ES module, which Deezer Eagle cannot patch yet. Nothing was changed.'
    }
    $node = Get-AsarNode $tree $entry
    $code = $script:Utf8.GetString((Read-AsarBytes $Source $header.DataOffset $node))
    if ($code.Contains($script:LoaderMarker)) { throw 'This copy of Deezer already contains the Eagle loader.' }

    $loader = [IO.File]::ReadAllText((Join-Path $script:EagleHome 'core/loader.js'))
    $loader = $loader.Replace('__EAGLE_HOME__', (ConvertTo-Json -InputObject $script:EagleHome -Compress))
    $patchedCode = $script:Utf8.GetBytes((Add-EagleLoader $code $loader))
    $marker = $script:Utf8.GetBytes((ConvertTo-Json -Compress -InputObject ([ordered]@{ eagle = Get-EagleVersion; home = $script:EagleHome; entry = $entry })))

    $dataLength = (Get-Item -LiteralPath $Source).Length - $header.DataOffset
    $executable = ''
    if (Get-Key $node 'executable') { $executable = ',"executable":true' }
    $entryJson = '{{"size":{0},"offset":"{1}","integrity":{2}{3}}}' -f $patchedCode.Length, $dataLength, (Get-AsarIntegrity $patchedCode), $executable
    $markerJson = '{{"size":{0},"offset":"{1}","integrity":{2}}}' -f $marker.Length, ($dataLength + $patchedCode.Length), (Get-AsarIntegrity $marker)
    $json = Set-AsarEntryJson $header.Json ($entry.Split('/')[-1]) ([string]$node['offset']) $entryJson
    $json = Add-AsarRootEntryJson $json 'eagle.json' $markerJson
    $headerBytes = ConvertTo-AsarHeaderBytes $json

    $output = [IO.File]::Open($Target, [IO.FileMode]::Create)
    try {
        $output.Write($headerBytes, 0, $headerBytes.Length)
        $original = Open-SharedRead $Source
        try {
            [void]$original.Seek($header.DataOffset, [IO.SeekOrigin]::Begin)
            $original.CopyTo($output)
        } finally {
            $original.Dispose()
        }
        $output.Write($patchedCode, 0, $patchedCode.Length)
        $output.Write($marker, 0, $marker.Length)
    } finally {
        $output.Dispose()
    }
}

# Puts back Deezer's archive moved aside by Eagle before 1.1 (Deezer closed).
function Undo-LegacyPatch($Paths) {
    if (-not (Test-Path -LiteralPath $Paths.Legacy)) { return }
    if (@('legacy', 'missing') -contains (Get-PatchState $Paths.Asar)) {
        if (Test-Path -LiteralPath $Paths.Asar) { Remove-Item -LiteralPath $Paths.Asar -Force }
        Move-Item -LiteralPath $Paths.Legacy -Destination $Paths.Asar
        if (Test-Path -LiteralPath $Paths.LegacyUnpacked) {
            if (Test-Path -LiteralPath $Paths.Unpacked) { Remove-Item -LiteralPath $Paths.Unpacked -Recurse -Force }
            Move-Item -LiteralPath $Paths.LegacyUnpacked -Destination $Paths.Unpacked
        }
    } else {
        # Deezer updated itself over the old patch: these are stale leftovers.
        Remove-Item -LiteralPath $Paths.Legacy -Force
        if (Test-Path -LiteralPath $Paths.LegacyUnpacked) { Remove-Item -LiteralPath $Paths.LegacyUnpacked -Recurse -Force }
    }
}

function Invoke-Apply {
    $dir = Get-DeezerOrFail
    $paths = Get-PatchPaths $dir
    Write-Step "Found Deezer: $dir"
    $wasRunning = $false
    if (Test-Path -LiteralPath $paths.Legacy) {
        $wasRunning = Stop-Deezer $dir
        Undo-LegacyPatch $paths
    }
    $state = Get-PatchState $paths.Asar
    if ($state -eq 'missing' -or $state -eq 'invalid') {
        throw 'Deezer''s app.asar is missing or damaged: reinstall Deezer, then run "eagle apply" again.'
    }
    if ($state -eq 'original') {
        $exe = Get-DeezerExe $dir
        $fuses = $null
        if ($exe) { $fuses = Get-ElectronFuses $exe }
        if ($fuses -and $fuses.Count -gt 4 -and $fuses[4] -eq '1') {
            throw 'This version of Deezer verifies the integrity of app.asar: Deezer Eagle cannot modify it without breaking it. Nothing was changed.'
        }
        # The untouched archive, for "eagle restore" and the next patches.
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $paths.Backup) | Out-Null
        Copy-Item -LiteralPath $paths.Asar -Destination $paths.Backup -Force
    } elseif (-not (Test-Path -LiteralPath $paths.Backup)) {
        throw 'Deezer is patched but Eagle''s backup of it is missing: reinstall Deezer, then run "eagle apply" again.'
    }

    Write-Step 'Adding Eagle to Deezer...'
    try {
        New-PatchedArchive $paths.Backup $paths.Building
    } catch {
        Remove-Item -LiteralPath $paths.Building -Force -ErrorAction SilentlyContinue
        throw
    }
    if (Stop-Deezer $dir) { $wasRunning = $true }
    try {
        Remove-Item -LiteralPath $paths.Asar -Force
        Move-Item -LiteralPath $paths.Building -Destination $paths.Asar
    } catch {
        if (-not (Test-Path -LiteralPath $paths.Asar)) { Copy-Item -LiteralPath $paths.Backup -Destination $paths.Asar }
        Remove-Item -LiteralPath $paths.Building -Force -ErrorAction SilentlyContinue
        throw
    }
    Write-Ok 'Deezer is patched: mods will load the next time it starts.'
    if ($wasRunning) { Start-Deezer $dir }
}

# Started in the background by the core when Deezer quits with an update
# pending: waits for the installer to replace app.asar, then patches again.
function Invoke-ReapplyAfterUpdate {
    $logFile = Join-Path $script:EagleHome 'logs/update.log'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null
    $log = { param($Text) Add-Content -LiteralPath $logFile -Value "[$((Get-Date).ToString('s'))] $Text" }
    & $log "Watcher started (pid $PID)."
    $deadline = (Get-Date).AddMinutes(15)
    # The installer deletes Deezer's files before writing the new ones: rely on
    # the folder the core passed rather than on finding app.asar right now.
    $dir = $env:DEEZER_EAGLE_DEEZER_PATH
    while (-not $dir -and (Get-Date) -lt $deadline) {
        $dir = Find-Deezer
        if (-not $dir) { Start-Sleep -Seconds 2 }
    }
    if (-not $dir) { & $log 'Deezer not found.'; return }
    $paths = Get-PatchPaths $dir
    & $log "Waiting for the Deezer update in $dir"
    while ((Get-Date) -lt $deadline) {
        if ((Get-PatchState $paths.Asar) -eq 'original') { break }
        Start-Sleep -Seconds 2
    }
    if ((Get-Date) -ge $deadline) { & $log 'No update was installed.'; return }
    # The installer may still be writing: wait until the archive stops changing
    # and no updater process is left.
    $lastSize = -1
    $stable = 0
    while ((Get-Date) -lt $deadline -and $stable -lt 3) {
        Start-Sleep -Seconds 2
        $item = Get-Item -LiteralPath $paths.Asar -ErrorAction SilentlyContinue
        $size = -1
        if ($item) { $size = $item.Length }
        $installers = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $processPath = $null
            try { $processPath = $_.Path } catch { }
            $processPath -and $processPath -like '*-updater*'
        })
        if ($size -ge 0 -and $size -eq $lastSize -and $installers.Count -eq 0) { $stable++ } else { $stable = 0 }
        $lastSize = $size
    }
    try {
        Invoke-Apply
        & $log 'Deezer is patched again.'
    } catch {
        & $log "Patching failed: $($_.Exception.Message)"
    }
}

function Invoke-Restore {
    $dir = Get-DeezerOrFail
    $paths = Get-PatchPaths $dir
    $legacy = Test-Path -LiteralPath $paths.Legacy
    $state = Get-PatchState $paths.Asar
    if (-not $legacy -and $state -ne 'patched') {
        Write-Ok 'Deezer is not patched, nothing to restore.'
        return
    }
    if ($state -eq 'patched' -and -not (Test-Path -LiteralPath $paths.Backup)) {
        throw 'Eagle''s backup of Deezer is missing: reinstall Deezer to repair it.'
    }
    $wasRunning = Stop-Deezer $dir
    if ($legacy) { Undo-LegacyPatch $paths }
    if ((Get-PatchState $paths.Asar) -eq 'patched') {
        Copy-Item -LiteralPath $paths.Backup -Destination $paths.Building -Force
        Remove-Item -LiteralPath $paths.Asar -Force
        Move-Item -LiteralPath $paths.Building -Destination $paths.Asar
    }
    Remove-Item -LiteralPath (Split-Path -Parent $paths.Backup) -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok 'Deezer is back to its original state.'
    if ($wasRunning) { Start-Deezer $dir }
}

# ---------------------------------------------------------------------------
# Mods
# ---------------------------------------------------------------------------

function Read-Manifest([string]$Dir) {
    try { return Read-Json (Join-Path $Dir 'manifest.json') } catch { return $null }
}

function Assert-Manifest($Manifest, [string]$Where) {
    if (-not $Manifest) { throw "No valid manifest.json in $Where" }
    if (-not ($Manifest.id -is [string]) -or $Manifest.id -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        throw "manifest.json ($Where): ""id"" must be lowercase (letters, digits, - or _)."
    }
    foreach ($field in @('name', 'version')) {
        if (-not $Manifest.$field) { throw "manifest.json ($Where): the ""$field"" field is required." }
    }
}

function Test-Linked([string]$Dir) {
    return [bool]((Get-Item -LiteralPath $Dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Removes a mod folder. A linked dev mod only loses its link, never its files.
function Remove-ModFolder([string]$Dir) {
    if (Test-Linked $Dir) {
        [IO.Directory]::Delete((Get-Item -LiteralPath $Dir -Force).FullName, $false)
    } else {
        Remove-Item -LiteralPath $Dir -Recurse -Force
    }
}

function Get-Mods {
    $config = Get-Config
    $mods = @()
    if (-not (Test-Path -LiteralPath $script:ModsDir)) { return $mods }
    foreach ($dir in (Get-ChildItem -LiteralPath $script:ModsDir -Directory -Force | Sort-Object Name)) {
        $manifest = Read-Manifest $dir.FullName
        if (-not $manifest) { continue }
        $linked = Test-Linked $dir.FullName
        $source = $null
        if (-not $linked) {
            try { $source = Read-Json (Join-Path $dir.FullName '.eagle-source.json') } catch { }
        }
        $type = 'mod'
        if ($manifest.type -eq 'theme') { $type = 'theme' }
        $mods += [pscustomobject]@{
            Id = $dir.Name
            Type = $type
            Name = [string]$manifest.name
            Version = [string]$manifest.version
            Description = [string]$manifest.description
            Enabled = -not ($config.disabled -contains $dir.Name)
            Linked = $linked
            Source = $source
            Dir = $dir.FullName
        }
    }
    return $mods
}

function Get-Mod([string]$Id) {
    $mod = @(Get-Mods) | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if (-not $mod) { throw "Mod ""$Id"" is not installed (see: eagle list)." }
    return $mod
}

function Format-Source($Source) {
    if (-not $Source) { return '' }
    if ($Source.type -eq 'local') { return [string]$Source.path }
    $text = [string]$Source.repo
    if ($Source.path) { $text += '/' + $Source.path }
    if ($Source.ref) { $text += '@' + $Source.ref }
    return $text
}

function Get-Registry {
    $location = $env:DEEZER_EAGLE_REGISTRY
    if (-not $location) { $location = "https://raw.githubusercontent.com/$script:Repo/$script:Branch/registry.json" }
    if ($location -notmatch '^https?://') { return Read-Json $location }
    $response = Invoke-WebRequest -Uri $location -UseBasicParsing -Headers @{ 'User-Agent' = 'Deezer-Eagle' }
    return ConvertFrom-Json -InputObject $response.Content
}

# Turns what the user typed into a source: a GitHub URL, a local folder,
# owner/repo[/path][@ref], or the id of a mod listed in registry.json.
# -RemoteOnly (installs asked by the Eagle library) never reads local folders.
function Resolve-ModSpec([string]$Spec, [bool]$RemoteOnly = $false) {
    if ($Spec -match '^https?://github\.com/([^/]+)/([^/#?]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.+?))?)?/?$') {
        return [ordered]@{ type = 'github'; repo = "$($Matches[1])/$($Matches[2])"; path = [string]$Matches[4]; ref = [string]$Matches[3] }
    }
    if ($Spec -match '^\.|\\|^[A-Za-z]:|^/') {
        if (-not $RemoteOnly -and (Test-Path -LiteralPath $Spec -PathType Container)) {
            return [ordered]@{ type = 'local'; path = (Get-FullPath $Spec) }
        }
        throw "Folder not found: $Spec"
    }
    if (-not $RemoteOnly -and (Test-Path -LiteralPath $Spec -PathType Container)) {
        return [ordered]@{ type = 'local'; path = (Get-FullPath $Spec) }
    }
    if ($Spec -match '^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)((?:/[^@]+)?)(?:@(.+))?$') {
        return [ordered]@{ type = 'github'; repo = "$($Matches[1])/$($Matches[2])"; path = ([string]$Matches[3]).Trim('/'); ref = [string]$Matches[4] }
    }
    $registry = $null
    try { $registry = Get-Registry } catch { Write-Warn "Mod registry unreachable: $($_.Exception.Message)" }
    if ($registry) {
        $entry = @($registry.mods) | Where-Object { $_.id -eq $Spec } | Select-Object -First 1
        if ($entry) {
            return [ordered]@{ type = 'github'; repo = [string]$entry.repo; path = [string]$entry.path; ref = [string]$entry.ref }
        }
    }
    throw "Mod not found: ""$Spec"". Try ""eagle search $Spec""."
}

function Test-Official($Source) {
    return $Source.type -eq 'github' -and $Source.repo -eq $script:Repo
}

# Returns the folder holding the mod's manifest.json, downloading it if needed.
function Get-ModSourceDir($Source, [string]$WorkDir) {
    if ($Source.type -eq 'local') {
        if (-not (Test-Path -LiteralPath $Source.path -PathType Container)) { throw "Folder not found: $($Source.path)" }
        return $Source.path
    }
    $ref = $Source.ref
    if (-not $ref) { $ref = 'HEAD' }
    $zip = Join-Path $WorkDir 'mod.zip'
    $extracted = Join-Path $WorkDir 'src'
    Write-Step "Downloading $($Source.repo)..."
    try {
        Invoke-Download "https://github.com/$($Source.repo)/archive/$ref.zip" $zip
    } catch {
        throw "Could not download github.com/$($Source.repo) ($ref): does the repository exist and is it public?"
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $extracted -Force
    $root = Get-ChildItem -LiteralPath $extracted -Directory | Select-Object -First 1
    if ($Source.path) {
        $dir = Join-Path $root.FullName $Source.path
        if (-not (Test-Path -LiteralPath (Join-Path $dir 'manifest.json'))) { throw "No manifest.json in $($Source.repo)/$($Source.path)" }
        return $dir
    }
    if (Test-Path -LiteralPath (Join-Path $root.FullName 'manifest.json')) { return $root.FullName }
    $found = @(Get-ChildItem -LiteralPath $root.FullName -Recurse -Depth 3 -File -Filter 'manifest.json' |
        Where-Object { $manifest = Read-Manifest $_.DirectoryName; $manifest -and $manifest.id })
    if ($found.Count -eq 1) { return $found[0].DirectoryName }
    if ($found.Count -gt 1) {
        $choices = $found | ForEach-Object { '    eagle install ' + $Source.repo + '/' + $_.DirectoryName.Substring($root.FullName.Length + 1).Replace('\', '/') }
        throw ("This repository contains several mods, pick one:`n" + ($choices -join "`n"))
    }
    throw "No mod (manifest.json) found in $($Source.repo)."
}

function Install-ModFrom([string]$Dir, $Source) {
    $manifest = Read-Manifest $Dir
    Assert-Manifest $manifest $Dir
    $target = Join-Path $script:ModsDir $manifest.id
    New-Item -ItemType Directory -Force -Path $script:ModsDir | Out-Null
    if (Test-Path -LiteralPath $target) { Remove-ModFolder $target }
    Copy-Item -LiteralPath $Dir -Destination $target -Recurse
    $git = Join-Path $target '.git'
    if (Test-Path -LiteralPath $git) { Remove-Item -LiteralPath $git -Recurse -Force }
    if ($Source) { Write-Json (Join-Path $target '.eagle-source.json') $Source }
    return $manifest
}

function Confirm-Trust($Manifest, $Source) {
    Write-Warn 'A mod runs code inside Deezer, with access to your Deezer account.'
    Write-Warn 'Only install mods from authors you trust.'
    $answer = Read-Host "  Install ""$($Manifest.name)"" from $(Format-Source $Source)? [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw 'Installation cancelled.' }
}

function Set-ModEnabled([string]$Id, [bool]$Enabled) {
    $config = Get-Config
    $config.disabled = @($config.disabled | Where-Object { $_ -ne $Id })
    if (-not $Enabled) { $config.disabled += $Id }
    Save-Config $config
}

function Invoke-Install([string[]]$Specs, [bool]$Yes, [bool]$RemoteOnly = $false) {
    if ($Specs.Count -eq 0) { throw 'Usage: eagle install <mod | owner/repo[/path][@ref] | url | folder>' }
    foreach ($spec in $Specs) {
        $source = Resolve-ModSpec $spec $RemoteOnly
        $work = New-TempDir
        try {
            $dir = Get-ModSourceDir $source $work
            $manifest = Read-Manifest $dir
            Assert-Manifest $manifest $spec
            if (-not $Yes -and -not (Test-Official $source)) { Confirm-Trust $manifest $source }
            $manifest = Install-ModFrom $dir $source
            Set-ModEnabled $manifest.id $true
            Write-Ok "Installed $($manifest.name) $($manifest.version) ($($manifest.id))."
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Reload
}

function Invoke-Remove([string[]]$Ids) {
    if ($Ids.Count -eq 0) { throw 'Usage: eagle remove <id>' }
    foreach ($id in $Ids) {
        $mod = Get-Mod $id
        Remove-ModFolder $mod.Dir
        $config = Get-Config
        $config.disabled = @($config.disabled | Where-Object { $_ -ne $id })
        Save-Config $config
        Write-Ok "Removed $($mod.Name)."
    }
    Write-Reload
}

function Invoke-Toggle([string[]]$Ids, [bool]$Enabled) {
    if ($Ids.Count -eq 0) { throw 'Usage: eagle enable|disable <id>' }
    foreach ($id in $Ids) {
        $mod = Get-Mod $id
        Set-ModEnabled $id $Enabled
        if ($Enabled) { Write-Ok "Enabled $($mod.Name)." } else { Write-Ok "Disabled $($mod.Name)." }
    }
    Write-Reload
}

function Invoke-List {
    $mods = @(Get-Mods)
    if ($mods.Count -eq 0) {
        Write-Host '  No mods installed. Find some with "eagle search".'
        return
    }
    $theme = (Get-Config).theme
    $mods | ForEach-Object {
        $state = 'enabled'
        if (-not $_.Enabled) { $state = 'disabled' }
        if ($_.Type -eq 'theme') {
            $state = ''
            if ($_.Id -eq $theme) { $state = 'active' }
        }
        $origin = Format-Source $_.Source
        if ($_.Linked) { $origin = 'link (dev)' }
        [pscustomobject]@{ ID = $_.Id; Type = $_.Type; Name = $_.Name; Version = $_.Version; State = $state; Source = $origin }
    } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

function Invoke-Theme([string]$Id) {
    $themes = @(Get-Mods | Where-Object { $_.Type -eq 'theme' })
    $config = Get-Config
    if (-not $Id) {
        if ($themes.Count -eq 0) { Write-Host '  No themes installed. Find some with "eagle search theme".'; return }
        foreach ($theme in $themes) {
            $marker = '   '
            if ($theme.Id -eq $config.theme) { $marker = ' * ' }
            Write-Host ("  {0}{1,-20} {2}" -f $marker, $theme.Id, $theme.Name)
        }
        Write-Host '  Switch with: eagle theme <id>   (eagle theme none: Deezer''s own colours)' -ForegroundColor DarkGray
        return
    }
    if ($Id -eq 'none' -or $Id -eq 'default') {
        $config.theme = $null
        Save-Config $config
        Write-Ok 'Back to Deezer''s own colours.'
    } else {
        $theme = $themes | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
        if (-not $theme) { throw "No theme ""$Id"" is installed (see: eagle theme)." }
        $config.theme = $Id
        Save-Config $config
        Write-Ok "Theme: $($theme.Name)."
    }
    Write-Reload
}

function Invoke-Update([string[]]$Ids) {
    $mods = @(Get-Mods)
    if ($Ids.Count -gt 0) { $mods = @($Ids | ForEach-Object { Get-Mod $_ }) }
    foreach ($mod in $mods) {
        if ($mod.Linked) { Write-Step "$($mod.Id): development link, skipped."; continue }
        if (-not $mod.Source) { Write-Step "$($mod.Id): unknown source, skipped."; continue }
        $work = New-TempDir
        try {
            $dir = Get-ModSourceDir $mod.Source $work
            $manifest = Read-Manifest $dir
            Assert-Manifest $manifest $dir
            if ($manifest.id -ne $mod.Id) { throw "the source now contains the mod ""$($manifest.id)""" }
            [void](Install-ModFrom $dir $mod.Source)
            if ($manifest.version -eq $mod.Version) { Write-Ok "$($mod.Name) is up to date ($($mod.Version))." }
            else { Write-Ok "$($mod.Name): $($mod.Version) -> $($manifest.version)" }
        } catch {
            Write-Warn "$($mod.Id): $($_.Exception.Message)"
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Reload
}

function Invoke-Search([string]$Query) {
    $rows = @()
    try {
        foreach ($entry in @((Get-Registry).mods)) {
            $haystack = "$($entry.id) $($entry.name) $($entry.description)"
            if (-not $Query -or $haystack -like "*$Query*") {
                $rows += [pscustomobject]@{ Install = $entry.id; Description = $entry.description; Stars = '' }
            }
        }
    } catch {
        Write-Warn "Mod registry unreachable: $($_.Exception.Message)"
    }
    try {
        $q = "topic:$script:Topic"
        if ($Query) { $q = "$Query $q" }
        $url = 'https://api.github.com/search/repositories?sort=stars&per_page=50&q=' + [uri]::EscapeDataString($q)
        $result = Invoke-RestMethod -Uri $url -UseBasicParsing -Headers @{ 'User-Agent' = 'Deezer-Eagle'; 'Accept' = 'application/vnd.github+json' }
        foreach ($item in @($result.items)) {
            if ($item.full_name -eq $script:Repo) { continue }
            $rows += [pscustomobject]@{ Install = $item.full_name; Description = $item.description; Stars = $item.stargazers_count }
        }
    } catch {
        Write-Warn "GitHub search unavailable: $($_.Exception.Message)"
    }
    if ($rows.Count -eq 0) {
        Write-Host '  No mods found.'
        return
    }
    $rows | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
    Write-Host '  Install with: eagle install <value of the Install column>' -ForegroundColor DarkGray
}

function New-Link([string]$Link, [string]$Target) {
    if ($script:OnWindows) {
        # Junctions need no admin rights, unlike symbolic links.
        New-Item -ItemType Junction -Path $Link -Value $Target | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $Link -Value $Target | Out-Null
    }
}

function Invoke-Link([string]$Path) {
    if (-not $Path) { throw 'Usage: eagle link <mod folder>' }
    $dir = Get-FullPath $Path
    $manifest = Read-Manifest $dir
    Assert-Manifest $manifest $dir
    $target = Join-Path $script:ModsDir $manifest.id
    New-Item -ItemType Directory -Force -Path $script:ModsDir | Out-Null
    if (Test-Path -LiteralPath $target) { Remove-ModFolder $target }
    New-Link $target $dir
    Set-ModEnabled $manifest.id $true
    Write-Ok "$($manifest.name) is linked from $($dir): your edits apply on every reload."
    Write-Reload
}

function Invoke-New([string]$Id) {
    if (-not $Id -or $Id -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        throw 'Usage: eagle new <id>   (lowercase id: letters, digits, - or _)'
    }
    $dir = Join-Path (Get-Location).ProviderPath $Id
    if (Test-Path -LiteralPath $dir) { throw "The folder $dir already exists." }
    $template = Join-Path $script:EagleHome 'template'
    if (-not (Test-Path -LiteralPath $template)) { throw "Template not found ($template): reinstall Deezer Eagle." }
    $author = $env:USERNAME
    if (-not $author) { $author = $env:USER }
    $title = (Get-Culture).TextInfo.ToTitleCase(($Id -replace '[-_]', ' '))
    New-Item -ItemType Directory -Path $dir | Out-Null
    foreach ($file in (Get-ChildItem -LiteralPath $template -File)) {
        $text = [IO.File]::ReadAllText($file.FullName)
        $text = $text.Replace('{{id}}', $Id).Replace('{{name}}', $title).Replace('{{author}}', [string]$author)
        Write-TextFile (Join-Path $dir $file.Name) $text
    }
    Write-Ok "Mod created in $dir"
    Invoke-Link $dir
    Write-Host ''
    Write-Host '  Next steps:' -ForegroundColor White
    Write-Host "    1. Edit $Id\mod.js and $Id\style.css"
    Write-Host '    2. Reload Deezer with Ctrl+Shift+R to see the result'
    Write-Host '    3. Turn on the dev console: eagle config devtools on (then Ctrl+Shift+I in Deezer)'
    Write-Host "    4. Publish the folder on GitHub with the ""$script:Topic"" topic"
}

function Invoke-Config([string[]]$Values) {
    $config = Get-Config
    if ($Values.Count -eq 0) {
        Write-Host "  devtools   : $($config.devtools)"
        Write-Host "  deezerPath : $($config.deezerPath)"
        Write-Host "  disabled   : $($config.disabled -join ', ')"
        return
    }
    switch ($Values[0]) {
        'devtools' {
            $config.devtools = @('on', 'true', '1', 'yes') -contains [string]$Values[1]
            Save-Config $config
            Write-Ok "devtools = $($config.devtools) (Ctrl+Shift+I in Deezer, after a restart)."
        }
        'deezerPath' {
            if ($Values.Count -lt 2 -or -not $Values[1]) { $config.deezerPath = '' }
            else { $config.deezerPath = Get-FullPath $Values[1] }
            Save-Config $config
            Write-Ok "deezerPath = $($config.deezerPath)"
        }
        default { throw "Unknown option: $($Values[0]) (devtools, deezerPath)" }
    }
}

function Invoke-Css {
    if (-not (Test-Path -LiteralPath $script:UserCss)) { Write-TextFile $script:UserCss "/* Your own CSS, applied after every mod. */`n" }
    Write-Host "  $script:UserCss"
    if ($script:OnWindows) { Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$script:UserCss`"" }
    Write-Reload
}

function Invoke-Logs {
    $log = Join-Path $script:EagleHome 'logs/main.log'
    if (-not (Test-Path -LiteralPath $log)) { Write-Host '  No log yet: start Deezer once it is patched.'; return }
    Get-Content -LiteralPath $log -Tail 100 | Write-Host
}

function Invoke-Status {
    Write-Host "  Deezer Eagle $(Get-EagleVersion)" -ForegroundColor Magenta
    Write-Host "  Folder : $script:EagleHome"
    $dir = $null
    try { $dir = Find-Deezer } catch { Write-Warn $_.Exception.Message }
    if (-not $dir) {
        Write-Host '  Deezer : not found'
    } else {
        $paths = Get-PatchPaths $dir
        $state = 'not patched (run "eagle apply")'
        switch (Get-PatchState $paths.Asar) {
            'patched' { $state = 'patched' }
            'legacy' { $state = 'patched the old way: run "eagle apply" to update it' }
            'original' { if (Test-Path -LiteralPath $paths.Backup) { $state = 'Deezer was updated, run "eagle apply" again' } }
        }
        Write-Host "  Deezer : $dir"
        Write-Host "  Patch  : $state"
    }
    $mods = @(Get-Mods)
    $active = @($mods | Where-Object { $_.Enabled }).Count
    Write-Host "  Mods   : $($mods.Count) installed, $active enabled"
}

function Invoke-Restart {
    $dir = Get-DeezerOrFail
    [void](Stop-Deezer $dir)
    Start-Deezer $dir
}

function Invoke-Upgrade {
    $url = "https://raw.githubusercontent.com/$script:Repo/$script:Branch/install.ps1"
    Write-Step 'Updating Deezer Eagle...'
    $installer = (Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{ 'User-Agent' = 'Deezer-Eagle' }).Content
    Invoke-Expression $installer
}

# ---------------------------------------------------------------------------
# Setup (run by install.ps1) and uninstall
# ---------------------------------------------------------------------------

function Get-UserPathEntries {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try {
        $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $key.Close()
    }
    return @($value.Split(';') | Where-Object { $_ })
}

# Writes the user PATH as REG_EXPAND_SZ so entries like %USERPROFILE% survive.
function Set-UserPathEntries([string[]]$Entries) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $key.SetValue('Path', ($Entries -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
        $key.Close()
    }
    # Setting any user variable broadcasts WM_SETTINGCHANGE so new terminals see the PATH.
    [Environment]::SetEnvironmentVariable('DEEZER_EAGLE_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('DEEZER_EAGLE_PATH_REFRESH', $null, 'User')
}

function Copy-Folder([string]$From, [string]$To) {
    if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
    Copy-Item -LiteralPath $From -Destination $To -Recurse
}

function Invoke-Setup([string]$SourceDir, [bool]$NoApply) {
    if (-not $SourceDir -or -not (Test-Path -LiteralPath (Join-Path $SourceDir 'src/core/main.js'))) {
        throw 'Internal usage: eagle setup <Deezer Eagle source folder>'
    }
    $SourceDir = Get-FullPath $SourceDir
    $firstInstall = -not (Test-Path -LiteralPath $script:ConfigFile)
    New-Item -ItemType Directory -Force -Path $script:EagleHome, $script:ModsDir, (Join-Path $script:EagleHome 'cli'), (Join-Path $script:EagleHome 'bin') | Out-Null

    Copy-Folder (Join-Path $SourceDir 'src/core') (Join-Path $script:EagleHome 'core')
    Copy-Folder (Join-Path $SourceDir 'src/template') (Join-Path $script:EagleHome 'template')
    Copy-Item -LiteralPath (Join-Path $SourceDir 'src/cli/eagle.ps1') -Destination (Join-Path $script:EagleHome 'cli/eagle.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $SourceDir 'VERSION') -Destination (Join-Path $script:EagleHome 'VERSION') -Force
    Write-Ok "Deezer Eagle $(Get-EagleVersion) installed in $script:EagleHome"

    # `exit /b` sits on the same line so cmd never re-reads a file `eagle uninstall` deleted.
    $shim = "@powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\cli\eagle.ps1`" %* & exit /b`r`n"
    Write-TextFile (Join-Path $script:EagleHome 'bin/eagle.cmd') $shim
    if ($script:OnWindows) {
        $bin = Join-Path $script:EagleHome 'bin'
        $entries = Get-UserPathEntries
        if ($entries -notcontains $bin) {
            Set-UserPathEntries ($entries + $bin)
            Write-Ok 'Added the "eagle" command to your PATH.'
        }
    }

    if ($firstInstall) {
        Save-Config (Get-Config)
        Write-TextFile $script:UserCss "/* Your own CSS, applied after every mod. Open it with: eagle css */`n"
    }

    # Built-in mods and themes: installed versions are refreshed, and default
    # ones are installed once (never again if the user removed them).
    $config = Get-Config
    $offered = @($config['installedDefaults'] | Where-Object { $_ })
    if (-not $firstInstall -and -not $config.Contains('installedDefaults')) { $offered = @('adblock', 'no-tracking') }
    $registry = Read-Json (Join-Path $SourceDir 'registry.json')
    foreach ($entry in @($registry.mods)) {
        if ($entry.repo -ne $script:Repo) { continue }
        $installed = Join-Path $script:ModsDir $entry.id
        $refresh = $false
        if (Test-Path -LiteralPath $installed) {
            if (-not (Test-Linked $installed)) {
                $source = $null
                try { $source = Read-Json (Join-Path $installed '.eagle-source.json') } catch { }
                $refresh = $source -and (Test-Official $source)
            }
        } elseif ($entry.default -and $offered -notcontains $entry.id) {
            $refresh = $true
        }
        if ($entry.default -and $offered -notcontains $entry.id) { $offered += $entry.id }
        if ($refresh) {
            $source = [ordered]@{ type = 'github'; repo = $script:Repo; path = [string]$entry.path; ref = '' }
            $manifest = Install-ModFrom (Join-Path $SourceDir $entry.path) $source
            Write-Ok "$($manifest.name) $($manifest.version)"
        }
    }
    $config = Get-Config
    $config['installedDefaults'] = $offered
    Save-Config $config

    if (-not $NoApply) {
        try {
            Invoke-Apply
        } catch {
            Write-Warn $_.Exception.Message
            Write-Warn 'Run "eagle apply" once Deezer is installed.'
        }
    }

    Write-Host ''
    Write-Host '  Deezer Eagle is ready!' -ForegroundColor Magenta
    Write-Host '    eagle list           installed mods'
    Write-Host '    eagle search         find mods'
    Write-Host '    eagle help           all commands'
    Write-Host '    "Eagle" in Deezer''s sidebar: your mods and the marketplace'
}

function Invoke-Uninstall([bool]$Yes) {
    if (-not $Yes) {
        $answer = Read-Host '  Remove Deezer Eagle and all its mods? [y/N]'
        if ($answer -notmatch '^(y|yes)$') { throw 'Uninstall cancelled.' }
    }
    if (Find-Deezer) { Invoke-Restore }
    if ($script:OnWindows) {
        $bin = Join-Path $script:EagleHome 'bin'
        Set-UserPathEntries @(Get-UserPathEntries | Where-Object { $_ -ne $bin })
    }
    # Unlink dev mods first so deleting the folder never touches their sources.
    if (Test-Path -LiteralPath $script:ModsDir) {
        Get-ChildItem -LiteralPath $script:ModsDir -Directory -Force | Where-Object { Test-Linked $_.FullName } | ForEach-Object { Remove-ModFolder $_.FullName }
    }
    Remove-Item -LiteralPath $script:EagleHome -Recurse -Force
    Write-Ok 'Deezer Eagle is uninstalled and Deezer is back to its original state.'
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

function Show-Help {
    Write-Host "  Deezer Eagle $(Get-EagleVersion) - mods for Deezer Desktop" -ForegroundColor Magenta
    Write-Host @'

  Deezer
    eagle apply                  patch Deezer (run it again after a Deezer update)
    eagle restore                put Deezer back to its original state
    eagle status                 installation status
    eagle restart                restart Deezer

  Mods
    eagle list                   installed mods
    eagle search [term]          find mods (registry + GitHub)
    eagle install <mod>          install: registry id, owner/repo[/path][@ref],
                                 GitHub URL or local folder   (-y: no confirmation)
    eagle remove <id>            remove a mod
    eagle enable <id>            enable a mod
    eagle disable <id>           disable a mod
    eagle update [id]            update mods from their source
    eagle theme [id | none]      list themes or switch theme

  Making mods
    eagle new <id>               create a mod from the template and link it
    eagle link <folder>          use a mod in development from its folder
    eagle config devtools on     enable the dev console (Ctrl+Shift+I in Deezer)
    eagle css                    open your own CSS (user.css)
    eagle logs                   loader log

  Deezer Eagle
    eagle config [key value]     options: devtools, deezerPath
    eagle upgrade                update Deezer Eagle
    eagle uninstall              remove everything
'@
}

function Invoke-Eagle([string[]]$Argv) {
    $command = 'help'
    $rest = @()
    if ($Argv.Count -gt 0) {
        $command = $Argv[0]
        $rest = @($Argv | Select-Object -Skip 1)
    }
    $flags = @($rest | Where-Object { $_ -like '-*' })
    $values = @($rest | Where-Object { $_ -notlike '-*' })
    $yes = ($flags -contains '-y') -or ($flags -contains '--yes')
    switch ($command) {
        'apply' { Invoke-Apply }
        'restore' { Invoke-Restore }
        'status' { Invoke-Status }
        'restart' { Invoke-Restart }
        'list' { Invoke-List }
        'search' { Invoke-Search ($values -join ' ') }
        'install' { Invoke-Install $values $yes ($flags -contains '--remote') }
        'remove' { Invoke-Remove $values }
        'enable' { Invoke-Toggle $values $true }
        'disable' { Invoke-Toggle $values $false }
        'update' { Invoke-Update $values }
        'theme' { Invoke-Theme $values[0] }
        'new' { Invoke-New $values[0] }
        'link' { Invoke-Link $values[0] }
        'config' { Invoke-Config $values }
        'css' { Invoke-Css }
        'logs' { Invoke-Logs }
        'upgrade' { Invoke-Upgrade }
        'uninstall' { Invoke-Uninstall $yes }
        'setup' { Invoke-Setup $values[0] ($flags -contains '--no-apply') }
        'reapply-after-update' { Invoke-ReapplyAfterUpdate }
        'version' { Write-Host (Get-EagleVersion) }
        { $_ -in @('help', '-h', '--help', '/?') } { Show-Help }
        default { throw "Unknown command: ""$command"". Type ""eagle help""." }
    }
}

# Dot-sourcing (tests) only loads the functions.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-Eagle $args
        exit 0
    } catch {
        Write-Host ''
        Write-Host "  [!] $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

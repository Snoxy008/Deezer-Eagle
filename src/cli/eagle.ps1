# Deezer Eagle - command line interface (`eagle help` for usage).
#
# Must keep working on Windows PowerShell 5.1: no ternaries, no `??`,
# no ConvertFrom-Json -AsHashtable. Saved as UTF-8 with BOM so 5.1 reads
# the accented messages correctly.

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
function Write-Reload { Write-Host '  Recharge Deezer (Ctrl+Shift+R) ou redémarre-le pour appliquer.' -ForegroundColor DarkGray }

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
    $config = [ordered]@{ disabled = @(); devtools = $false; deezerPath = '' }
    $raw = $null
    try { $raw = Read-Json $script:ConfigFile } catch { Write-Warn "config.json illisible, valeurs par défaut utilisées." }
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
            throw "Archive asar invalide : $Path"
        }
        $json = $script:Utf8.GetString($reader.ReadBytes($jsonLength))
        return [pscustomobject]@{ Json = $json; DataOffset = 8 + [int64]$headerSize }
    } finally {
        $stream.Dispose()
    }
}

function Read-AsarEntry([string]$Path, [string]$Name) {
    $header = Read-AsarHeader $Path
    $node = ConvertFrom-JsonDictionary $header.Json
    foreach ($part in $Name.Split('/')) {
        $files = $node['files']
        if (-not $files -or -not ($files.Keys -contains $part)) { throw "$Name absent de $Path" }
        $node = $files[$part]
    }
    $offset = [int64]$node['offset']
    $size = [int]$node['size']
    $stream = Open-SharedRead $Path
    try {
        [void]$stream.Seek($header.DataOffset + $offset, [IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] $size
        $read = 0
        while ($read -lt $size) {
            $count = $stream.Read($buffer, $read, $size - $read)
            if ($count -le 0) { throw "Archive asar tronquée : $Path" }
            $read += $count
        }
        return , $buffer
    } finally {
        $stream.Dispose()
    }
}

# Writes a flat archive from an ordered dictionary of name -> byte[].
function Write-Asar([string]$Path, $Files) {
    $entries = @()
    $offset = 0
    foreach ($name in $Files.Keys) {
        $entries += '"{0}":{{"size":{1},"offset":"{2}"}}' -f $name, $Files[$name].Length, $offset
        $offset += $Files[$name].Length
    }
    $json = $script:Utf8.GetBytes('{"files":{' + ($entries -join ',') + '}}')
    $padding = (4 - ($json.Length % 4)) % 4
    $payloadSize = 4 + $json.Length + $padding
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create)
    try {
        $writer = New-Object IO.BinaryWriter $stream
        $writer.Write([uint32]4)
        $writer.Write([uint32](4 + $payloadSize))
        $writer.Write([uint32]$payloadSize)
        $writer.Write([int32]$json.Length)
        $writer.Write($json)
        $writer.Write((New-Object byte[] $padding))
        foreach ($name in $Files.Keys) { $writer.Write([byte[]]$Files[$name]) }
        $writer.Flush()
    } finally {
        $stream.Dispose()
    }
}

function Test-EagleStub([string]$Asar) {
    if (-not (Test-Path -LiteralPath $Asar -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Asar).Length -gt 1MB) { return $false }
    try { return (Read-AsarHeader $Asar).Json.Contains('"eagle.json"') } catch { return $false }
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
                throw "La version Microsoft Store de Deezer ne peut pas être modifiée. Installe la version classique depuis https://www.deezer.com/fr/download"
            }
            return $full
        }
    }
    return $null
}

function Get-DeezerOrFail {
    $dir = Find-Deezer
    if (-not $dir) {
        throw "Deezer Desktop introuvable. Installe-le depuis https://www.deezer.com/fr/download (pas la version Microsoft Store), ou indique son dossier : eagle config deezerPath <dossier>"
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
    Write-Step 'Fermeture de Deezer...'
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 50 -and (Get-DeezerProcesses $Dir).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 500
    return $true
}

function Start-Deezer([string]$Dir) {
    $exe = Get-DeezerExe $Dir
    if ($exe) {
        Write-Step 'Lancement de Deezer...'
        Start-Process -FilePath $exe
    }
}

function Get-PatchPaths([string]$Dir) {
    $resources = Join-Path $Dir 'resources'
    return [pscustomobject]@{
        Asar = Join-Path $resources 'app.asar'
        Unpacked = Join-Path $resources 'app.asar.unpacked'
        Original = Join-Path $resources '_app.asar'
        OriginalUnpacked = Join-Path $resources '_app.asar.unpacked'
    }
}

# The stub mirrors the fields Electron reads from package.json at startup, so
# Deezer keeps its name, version and user data folder (and stays logged in).
function New-StubFiles([byte[]]$PackageJson) {
    $pkg = ConvertFrom-Json -InputObject ($script:Utf8.GetString($PackageJson).TrimStart([char]0xFEFF))
    $stubPkg = [ordered]@{}
    foreach ($field in @('name', 'productName', 'version', 'desktopName', 'v8Flags')) {
        if ($pkg.PSObject.Properties[$field]) { $stubPkg[$field] = $pkg.$field }
    }
    $stubPkg['main'] = 'eagle-stub.js'
    $eagle = [ordered]@{ home = $script:EagleHome; version = Get-EagleVersion }
    $files = [ordered]@{}
    $files['eagle-stub.js'] = [IO.File]::ReadAllBytes((Join-Path $script:EagleHome 'core/stub/index.js'))
    $files['eagle.json'] = $script:Utf8.GetBytes((ConvertTo-JsonText $eagle))
    $files['package.json'] = $script:Utf8.GetBytes((ConvertTo-JsonText $stubPkg))
    return $files
}

function Invoke-Apply {
    $dir = Get-DeezerOrFail
    $paths = Get-PatchPaths $dir
    if (-not (Test-Path -LiteralPath $paths.Asar -PathType Leaf)) { throw "app.asar introuvable dans $dir\resources" }
    Write-Step "Deezer trouvé : $dir"

    $patched = Test-EagleStub $paths.Asar
    if ($patched) {
        if (-not (Test-Path -LiteralPath $paths.Original)) {
            throw "Le patch est cassé (_app.asar manquant). Réinstalle Deezer puis relance « eagle apply »."
        }
        $source = $paths.Original
    } else {
        $exe = Get-DeezerExe $dir
        $fuses = $null
        if ($exe) { $fuses = Get-ElectronFuses $exe }
        if ($fuses -and $fuses.Count -gt 4 -and $fuses[4] -eq '1') {
            throw "Cette version de Deezer vérifie l'intégrité de app.asar : Deezer Eagle ne peut pas la modifier sans la casser. Rien n'a été modifié."
        }
        $source = $paths.Asar
    }
    $stub = New-StubFiles (Read-AsarEntry $source 'package.json')

    $wasRunning = Stop-Deezer $dir
    if (-not $patched) {
        # A leftover _app.asar means Deezer updated itself over an older patch.
        if (Test-Path -LiteralPath $paths.Original) { Remove-Item -LiteralPath $paths.Original -Force }
        if (Test-Path -LiteralPath $paths.OriginalUnpacked) { Remove-Item -LiteralPath $paths.OriginalUnpacked -Recurse -Force }
        Move-Item -LiteralPath $paths.Asar -Destination $paths.Original
        if (Test-Path -LiteralPath $paths.Unpacked) { Move-Item -LiteralPath $paths.Unpacked -Destination $paths.OriginalUnpacked }
    }
    try {
        Write-Asar $paths.Asar $stub
    } catch {
        if (-not $patched) {
            Remove-Item -LiteralPath $paths.Asar -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $paths.Original -Destination $paths.Asar
            if (Test-Path -LiteralPath $paths.OriginalUnpacked) { Move-Item -LiteralPath $paths.OriginalUnpacked -Destination $paths.Unpacked }
        }
        throw
    }
    Write-Ok 'Deezer est patché : les mods se chargeront au prochain lancement.'
    if ($wasRunning) { Start-Deezer $dir }
}

function Invoke-Restore {
    $dir = Get-DeezerOrFail
    $paths = Get-PatchPaths $dir
    if (-not (Test-EagleStub $paths.Asar)) {
        Write-Ok "Deezer n'est pas patché, rien à restaurer."
        return
    }
    if (-not (Test-Path -LiteralPath $paths.Original)) {
        throw "_app.asar est introuvable : réinstalle Deezer pour le réparer."
    }
    $wasRunning = Stop-Deezer $dir
    Remove-Item -LiteralPath $paths.Asar -Force
    Move-Item -LiteralPath $paths.Original -Destination $paths.Asar
    if (Test-Path -LiteralPath $paths.OriginalUnpacked) {
        if (Test-Path -LiteralPath $paths.Unpacked) { Remove-Item -LiteralPath $paths.Unpacked -Recurse -Force }
        Move-Item -LiteralPath $paths.OriginalUnpacked -Destination $paths.Unpacked
    }
    Write-Ok "Deezer est restauré à son état d'origine."
    if ($wasRunning) { Start-Deezer $dir }
}

# ---------------------------------------------------------------------------
# Mods
# ---------------------------------------------------------------------------

function Read-Manifest([string]$Dir) {
    try { return Read-Json (Join-Path $Dir 'manifest.json') } catch { return $null }
}

function Assert-Manifest($Manifest, [string]$Where) {
    if (-not $Manifest) { throw "Pas de manifest.json valide dans $Where" }
    if (-not ($Manifest.id -is [string]) -or $Manifest.id -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        throw "manifest.json ($Where) : « id » doit être en minuscules (lettres, chiffres, - ou _)."
    }
    foreach ($field in @('name', 'version')) {
        if (-not $Manifest.$field) { throw "manifest.json ($Where) : le champ « $field » est obligatoire." }
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
        $mods += [pscustomobject]@{
            Id = $dir.Name
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
    if (-not $mod) { throw "Le mod « $Id » n'est pas installé (eagle list)." }
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

# Turns what the user typed into a source: a local folder, a GitHub URL,
# owner/repo[/path][@ref], or the id of a mod listed in registry.json.
function Resolve-ModSpec([string]$Spec) {
    if ($Spec -match '^https?://github\.com/([^/]+)/([^/#?]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.+?))?)?/?$') {
        return [ordered]@{ type = 'github'; repo = "$($Matches[1])/$($Matches[2])"; path = [string]$Matches[4]; ref = [string]$Matches[3] }
    }
    if (Test-Path -LiteralPath $Spec -PathType Container) {
        return [ordered]@{ type = 'local'; path = (Get-FullPath $Spec) }
    }
    if ($Spec -match '^\.|\\|^[A-Za-z]:') { throw "Dossier introuvable : $Spec" }
    if ($Spec -match '^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)((?:/[^@]+)?)(?:@(.+))?$') {
        return [ordered]@{ type = 'github'; repo = "$($Matches[1])/$($Matches[2])"; path = ([string]$Matches[3]).Trim('/'); ref = [string]$Matches[4] }
    }
    $registry = $null
    try { $registry = Get-Registry } catch { Write-Warn "Registre des mods inaccessible : $($_.Exception.Message)" }
    if ($registry) {
        $entry = @($registry.mods) | Where-Object { $_.id -eq $Spec } | Select-Object -First 1
        if ($entry) {
            return [ordered]@{ type = 'github'; repo = [string]$entry.repo; path = [string]$entry.path; ref = [string]$entry.ref }
        }
    }
    throw "Mod introuvable : « $Spec ». Essaie « eagle search $Spec »."
}

function Test-Official($Source) {
    return $Source.type -eq 'github' -and $Source.repo -eq $script:Repo
}

# Returns the folder holding the mod's manifest.json, downloading it if needed.
function Get-ModSourceDir($Source, [string]$WorkDir) {
    if ($Source.type -eq 'local') {
        if (-not (Test-Path -LiteralPath $Source.path -PathType Container)) { throw "Dossier introuvable : $($Source.path)" }
        return $Source.path
    }
    $ref = $Source.ref
    if (-not $ref) { $ref = 'HEAD' }
    $zip = Join-Path $WorkDir 'mod.zip'
    $extracted = Join-Path $WorkDir 'src'
    Write-Step "Téléchargement de $($Source.repo)..."
    try {
        Invoke-Download "https://github.com/$($Source.repo)/archive/$ref.zip" $zip
    } catch {
        throw "Impossible de télécharger github.com/$($Source.repo) ($ref) : le dépôt existe-t-il et est-il public ?"
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $extracted -Force
    $root = Get-ChildItem -LiteralPath $extracted -Directory | Select-Object -First 1
    if ($Source.path) {
        $dir = Join-Path $root.FullName $Source.path
        if (-not (Test-Path -LiteralPath (Join-Path $dir 'manifest.json'))) { throw "Pas de manifest.json dans $($Source.repo)/$($Source.path)" }
        return $dir
    }
    if (Test-Path -LiteralPath (Join-Path $root.FullName 'manifest.json')) { return $root.FullName }
    $found = @(Get-ChildItem -LiteralPath $root.FullName -Recurse -Depth 3 -File -Filter 'manifest.json' |
        Where-Object { $manifest = Read-Manifest $_.DirectoryName; $manifest -and $manifest.id })
    if ($found.Count -eq 1) { return $found[0].DirectoryName }
    if ($found.Count -gt 1) {
        $choices = $found | ForEach-Object { '    eagle install ' + $Source.repo + '/' + $_.DirectoryName.Substring($root.FullName.Length + 1).Replace('\', '/') }
        throw ("Ce dépôt contient plusieurs mods, choisis-en un :`n" + ($choices -join "`n"))
    }
    throw "Aucun mod (manifest.json) trouvé dans $($Source.repo)."
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
    Write-Warn "Un mod exécute du code dans Deezer, avec accès à ton compte."
    Write-Warn "N'installe que des mods dont tu as confiance en l'auteur."
    $answer = Read-Host "  Installer « $($Manifest.name) » depuis $(Format-Source $Source) ? [o/N]"
    if ($answer -notmatch '^(o|oui|y|yes)$') { throw 'Installation annulée.' }
}

function Set-ModEnabled([string]$Id, [bool]$Enabled) {
    $config = Get-Config
    $config.disabled = @($config.disabled | Where-Object { $_ -ne $Id })
    if (-not $Enabled) { $config.disabled += $Id }
    Save-Config $config
}

function Invoke-Install([string[]]$Specs, [bool]$Yes) {
    if ($Specs.Count -eq 0) { throw 'Usage : eagle install <mod | owner/repo[/chemin][@ref] | url | dossier>' }
    foreach ($spec in $Specs) {
        $source = Resolve-ModSpec $spec
        $work = New-TempDir
        try {
            $dir = Get-ModSourceDir $source $work
            $manifest = Read-Manifest $dir
            Assert-Manifest $manifest $spec
            if (-not $Yes -and -not (Test-Official $source)) { Confirm-Trust $manifest $source }
            $manifest = Install-ModFrom $dir $source
            Set-ModEnabled $manifest.id $true
            Write-Ok "$($manifest.name) $($manifest.version) installé ($($manifest.id))."
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Reload
}

function Invoke-Remove([string[]]$Ids) {
    if ($Ids.Count -eq 0) { throw 'Usage : eagle remove <id>' }
    foreach ($id in $Ids) {
        $mod = Get-Mod $id
        Remove-ModFolder $mod.Dir
        $config = Get-Config
        $config.disabled = @($config.disabled | Where-Object { $_ -ne $id })
        Save-Config $config
        Write-Ok "$($mod.Name) supprimé."
    }
    Write-Reload
}

function Invoke-Toggle([string[]]$Ids, [bool]$Enabled) {
    if ($Ids.Count -eq 0) { throw 'Usage : eagle enable|disable <id>' }
    foreach ($id in $Ids) {
        $mod = Get-Mod $id
        Set-ModEnabled $id $Enabled
        if ($Enabled) { Write-Ok "$($mod.Name) activé." } else { Write-Ok "$($mod.Name) désactivé." }
    }
    Write-Reload
}

function Invoke-List {
    $mods = @(Get-Mods)
    if ($mods.Count -eq 0) {
        Write-Host '  Aucun mod installé. Cherche-en avec « eagle search ».'
        return
    }
    $mods | ForEach-Object {
        $state = 'activé'
        if (-not $_.Enabled) { $state = 'désactivé' }
        $origin = Format-Source $_.Source
        if ($_.Linked) { $origin = 'lien (dev)' }
        [pscustomobject]@{ ID = $_.Id; Nom = $_.Name; Version = $_.Version; Etat = $state; Source = $origin }
    } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

function Invoke-Update([string[]]$Ids) {
    $mods = @(Get-Mods)
    if ($Ids.Count -gt 0) { $mods = @($Ids | ForEach-Object { Get-Mod $_ }) }
    foreach ($mod in $mods) {
        if ($mod.Linked) { Write-Step "$($mod.Id) : lien de développement, ignoré."; continue }
        if (-not $mod.Source) { Write-Step "$($mod.Id) : source inconnue, ignoré."; continue }
        $work = New-TempDir
        try {
            $dir = Get-ModSourceDir $mod.Source $work
            $manifest = Read-Manifest $dir
            Assert-Manifest $manifest $dir
            if ($manifest.id -ne $mod.Id) { throw "la source contient maintenant le mod « $($manifest.id) »" }
            [void](Install-ModFrom $dir $mod.Source)
            if ($manifest.version -eq $mod.Version) { Write-Ok "$($mod.Name) est à jour ($($mod.Version))." }
            else { Write-Ok "$($mod.Name) : $($mod.Version) -> $($manifest.version)" }
        } catch {
            Write-Warn "$($mod.Id) : $($_.Exception.Message)"
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
                $rows += [pscustomobject]@{ Installer = $entry.id; Description = $entry.description; Etoiles = '' }
            }
        }
    } catch {
        Write-Warn "Registre des mods inaccessible : $($_.Exception.Message)"
    }
    try {
        $q = "topic:$script:Topic"
        if ($Query) { $q = "$Query $q" }
        $url = 'https://api.github.com/search/repositories?sort=stars&per_page=50&q=' + [uri]::EscapeDataString($q)
        $result = Invoke-RestMethod -Uri $url -UseBasicParsing -Headers @{ 'User-Agent' = 'Deezer-Eagle'; 'Accept' = 'application/vnd.github+json' }
        foreach ($item in @($result.items)) {
            if ($item.full_name -eq $script:Repo) { continue }
            $rows += [pscustomobject]@{ Installer = $item.full_name; Description = $item.description; Etoiles = $item.stargazers_count }
        }
    } catch {
        Write-Warn "Recherche GitHub indisponible : $($_.Exception.Message)"
    }
    if ($rows.Count -eq 0) {
        Write-Host '  Aucun mod trouvé.'
        return
    }
    $rows | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
    Write-Host '  Installe avec : eagle install <valeur de la colonne Installer>' -ForegroundColor DarkGray
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
    if (-not $Path) { throw 'Usage : eagle link <dossier du mod>' }
    $dir = Get-FullPath $Path
    $manifest = Read-Manifest $dir
    Assert-Manifest $manifest $dir
    $target = Join-Path $script:ModsDir $manifest.id
    New-Item -ItemType Directory -Force -Path $script:ModsDir | Out-Null
    if (Test-Path -LiteralPath $target) { Remove-ModFolder $target }
    New-Link $target $dir
    Set-ModEnabled $manifest.id $true
    Write-Ok "$($manifest.name) est lié depuis $dir : tes modifications s'appliquent à chaque rechargement."
    Write-Reload
}

function Invoke-New([string]$Id) {
    if (-not $Id -or $Id -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') {
        throw 'Usage : eagle new <id>   (id en minuscules : lettres, chiffres, - ou _)'
    }
    $dir = Join-Path (Get-Location).ProviderPath $Id
    if (Test-Path -LiteralPath $dir) { throw "Le dossier $dir existe déjà." }
    $template = Join-Path $script:EagleHome 'template'
    if (-not (Test-Path -LiteralPath $template)) { throw "Modèle introuvable ($template) : réinstalle Deezer Eagle." }
    $author = $env:USERNAME
    if (-not $author) { $author = $env:USER }
    $title = (Get-Culture).TextInfo.ToTitleCase(($Id -replace '[-_]', ' '))
    New-Item -ItemType Directory -Path $dir | Out-Null
    foreach ($file in (Get-ChildItem -LiteralPath $template -File)) {
        $text = [IO.File]::ReadAllText($file.FullName)
        $text = $text.Replace('{{id}}', $Id).Replace('{{name}}', $title).Replace('{{author}}', [string]$author)
        Write-TextFile (Join-Path $dir $file.Name) $text
    }
    Write-Ok "Mod créé dans $dir"
    Invoke-Link $dir
    Write-Host ''
    Write-Host '  Ensuite :' -ForegroundColor White
    Write-Host "    1. Modifie $Id\mod.js et $Id\style.css"
    Write-Host '    2. Recharge Deezer avec Ctrl+Shift+R pour voir le résultat'
    Write-Host '    3. Active la console de debug : eagle config devtools on (puis Ctrl+Shift+I dans Deezer)'
    Write-Host "    4. Publie le dossier sur GitHub avec le topic « $script:Topic »"
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
            $config.devtools = @('on', 'true', '1', 'oui', 'yes') -contains [string]$Values[1]
            Save-Config $config
            Write-Ok "devtools = $($config.devtools) (Ctrl+Shift+I dans Deezer, après redémarrage)."
        }
        'deezerPath' {
            if ($Values.Count -lt 2 -or -not $Values[1]) { $config.deezerPath = '' }
            else { $config.deezerPath = Get-FullPath $Values[1] }
            Save-Config $config
            Write-Ok "deezerPath = $($config.deezerPath)"
        }
        default { throw "Option inconnue : $($Values[0]) (devtools, deezerPath)" }
    }
}

function Invoke-Css {
    if (-not (Test-Path -LiteralPath $script:UserCss)) { Write-TextFile $script:UserCss "/* Ton CSS perso, appliqué après tous les mods. */`n" }
    Write-Host "  $script:UserCss"
    if ($script:OnWindows) { Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$script:UserCss`"" }
    Write-Reload
}

function Invoke-Logs {
    $log = Join-Path $script:EagleHome 'logs/main.log'
    if (-not (Test-Path -LiteralPath $log)) { Write-Host '  Pas encore de log : lance Deezer une fois patché.'; return }
    Get-Content -LiteralPath $log -Tail 100 | Write-Host
}

function Invoke-Status {
    Write-Host "  Deezer Eagle $(Get-EagleVersion)" -ForegroundColor Magenta
    Write-Host "  Dossier : $script:EagleHome"
    $dir = $null
    try { $dir = Find-Deezer } catch { Write-Warn $_.Exception.Message }
    if (-not $dir) {
        Write-Host '  Deezer  : introuvable'
    } else {
        $paths = Get-PatchPaths $dir
        $state = 'non patché (eagle apply)'
        if (Test-EagleStub $paths.Asar) { $state = 'patché' }
        elseif (Test-Path -LiteralPath $paths.Original) { $state = 'Deezer a été mis à jour, relance « eagle apply »' }
        Write-Host "  Deezer  : $dir"
        Write-Host "  Patch   : $state"
    }
    $mods = @(Get-Mods)
    $active = @($mods | Where-Object { $_.Enabled }).Count
    Write-Host "  Mods    : $($mods.Count) installé(s), $active actif(s)"
}

function Invoke-Restart {
    $dir = Get-DeezerOrFail
    [void](Stop-Deezer $dir)
    Start-Deezer $dir
}

function Invoke-Upgrade {
    $url = "https://raw.githubusercontent.com/$script:Repo/$script:Branch/install.ps1"
    Write-Step 'Mise à jour de Deezer Eagle...'
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
        throw 'Usage interne : eagle setup <dossier des sources de Deezer Eagle>'
    }
    $SourceDir = Get-FullPath $SourceDir
    $firstInstall = -not (Test-Path -LiteralPath $script:ConfigFile)
    New-Item -ItemType Directory -Force -Path $script:EagleHome, $script:ModsDir, (Join-Path $script:EagleHome 'cli'), (Join-Path $script:EagleHome 'bin') | Out-Null

    Copy-Folder (Join-Path $SourceDir 'src/core') (Join-Path $script:EagleHome 'core')
    Copy-Folder (Join-Path $SourceDir 'src/template') (Join-Path $script:EagleHome 'template')
    Copy-Item -LiteralPath (Join-Path $SourceDir 'src/cli/eagle.ps1') -Destination (Join-Path $script:EagleHome 'cli/eagle.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $SourceDir 'VERSION') -Destination (Join-Path $script:EagleHome 'VERSION') -Force
    Write-Ok "Deezer Eagle $(Get-EagleVersion) installé dans $script:EagleHome"

    # `exit /b` sits on the same line so cmd never re-reads a file `eagle uninstall` deleted.
    $shim = "@powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\cli\eagle.ps1`" %* & exit /b`r`n"
    Write-TextFile (Join-Path $script:EagleHome 'bin/eagle.cmd') $shim
    if ($script:OnWindows) {
        $bin = Join-Path $script:EagleHome 'bin'
        $entries = Get-UserPathEntries
        if ($entries -notcontains $bin) {
            Set-UserPathEntries ($entries + $bin)
            Write-Ok 'Commande « eagle » ajoutée au PATH.'
        }
    }

    if ($firstInstall) {
        Save-Config (Get-Config)
        Write-TextFile $script:UserCss "/* Ton CSS perso, appliqué après tous les mods. Ouvre-le avec : eagle css */`n"
    }

    # Built-in mods: installed on first install, refreshed on upgrade.
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
        } elseif ($firstInstall -and $entry.default) {
            $refresh = $true
        }
        if ($refresh) {
            $source = [ordered]@{ type = 'github'; repo = $script:Repo; path = [string]$entry.path; ref = '' }
            $manifest = Install-ModFrom (Join-Path $SourceDir $entry.path) $source
            Write-Ok "Mod $($manifest.name) $($manifest.version)"
        }
    }

    if (-not $NoApply) {
        try {
            Invoke-Apply
        } catch {
            Write-Warn $_.Exception.Message
            Write-Warn 'Lance « eagle apply » une fois Deezer installé.'
        }
    }

    Write-Host ''
    Write-Host '  Deezer Eagle est prêt !' -ForegroundColor Magenta
    Write-Host '    eagle list           mods installés'
    Write-Host '    eagle search         trouver des mods'
    Write-Host '    eagle help           toutes les commandes'
    Write-Host '    Ctrl+Shift+E         panneau Eagle dans Deezer'
}

function Invoke-Uninstall([bool]$Yes) {
    if (-not $Yes) {
        $answer = Read-Host '  Supprimer Deezer Eagle et tous ses mods ? [o/N]'
        if ($answer -notmatch '^(o|oui|y|yes)$') { throw 'Désinstallation annulée.' }
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
    Write-Ok 'Deezer Eagle est désinstallé. Deezer est revenu à son état d''origine.'
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

function Show-Help {
    Write-Host "  Deezer Eagle $(Get-EagleVersion) - mods pour Deezer Desktop" -ForegroundColor Magenta
    Write-Host @'

  Deezer
    eagle apply                  patche Deezer (à relancer après une mise à jour de Deezer)
    eagle restore                remet Deezer d'origine
    eagle status                 état de l'installation
    eagle restart                redémarre Deezer

  Mods
    eagle list                   mods installés
    eagle search [mot]           cherche des mods (registre + GitHub)
    eagle install <mod>          installe : id du registre, owner/repo[/chemin][@ref],
                                 URL GitHub ou dossier local   (-y : sans confirmation)
    eagle remove <id>            supprime un mod
    eagle enable <id>            active un mod
    eagle disable <id>           désactive un mod
    eagle update [id]            met à jour les mods depuis leur source

  Créer des mods
    eagle new <id>               crée un mod à partir du modèle et le lie
    eagle link <dossier>         utilise un mod en développement depuis son dossier
    eagle config devtools on     active la console (Ctrl+Shift+I dans Deezer)
    eagle css                    ouvre ton CSS perso (user.css)
    eagle logs                   journal du chargeur

  Deezer Eagle
    eagle config [clé valeur]    options : devtools, deezerPath
    eagle upgrade                met à jour Deezer Eagle
    eagle uninstall              désinstalle tout
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
        'install' { Invoke-Install $values $yes }
        'remove' { Invoke-Remove $values }
        'enable' { Invoke-Toggle $values $true }
        'disable' { Invoke-Toggle $values $false }
        'update' { Invoke-Update $values }
        'new' { Invoke-New $values[0] }
        'link' { Invoke-Link $values[0] }
        'config' { Invoke-Config $values }
        'css' { Invoke-Css }
        'logs' { Invoke-Logs }
        'upgrade' { Invoke-Upgrade }
        'uninstall' { Invoke-Uninstall $yes }
        'setup' { Invoke-Setup $values[0] ($flags -contains '--no-apply') }
        'version' { Write-Host (Get-EagleVersion) }
        { $_ -in @('help', '-h', '--help', '/?') } { Show-Help }
        default { throw "Commande inconnue : « $command ». Tape « eagle help »." }
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

param([switch]$Release)
$ErrorActionPreference = 'Stop'
function Get-NativeHash([string]$FilePath) {
  $stream = [IO.File]::OpenRead($FilePath)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $hasher.Dispose() }
}
$projectRoot = Split-Path $PSScriptRoot -Parent
$manifest = Join-Path $projectRoot 'native/hcom/Cargo.toml'
$profileName = if ($Release) { 'release' } else { 'debug' }
$profileArgs = if ($Release) { @('--release') } else { @() }
# Use a known local toolchain. Do not change the user's global Rust configuration.
& cargo +1.92.0 build --locked --manifest-path $manifest --bin hcom @profileArgs
if ($LASTEXITCODE -ne 0) { throw 'Hook helper build failed.' }
& cargo +1.92.0 build --locked --manifest-path $manifest --lib --features native @profileArgs
if ($LASTEXITCODE -ne 0) { throw 'Native module build failed.' }
$nativeBin = Join-Path $projectRoot 'native/bin'
New-Item -ItemType Directory -Force $nativeBin | Out-Null
$moduleSource = Join-Path $projectRoot "native/hcom/target/$profileName/agent_room_hcom.dll"
$helperSource = Join-Path $projectRoot "native/hcom/target/$profileName/hcom.exe"
$moduleHash = Get-NativeHash $moduleSource
$helperHash = Get-NativeHash $helperSource
$buildName = ($moduleHash.Substring(0, 16) + $helperHash.Substring(0, 16)).ToLowerInvariant()
$buildDir = Join-Path $nativeBin $buildName
New-Item -ItemType Directory -Force $buildDir | Out-Null
# Never overwrite a loaded DLL or a helper used by an active session.
foreach ($entry in @(@($moduleSource, 'agent_room_hcom.node', $moduleHash), @($helperSource, 'hcom.exe', $helperHash))) {
  $destination = Join-Path $buildDir $entry[1]
  if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $entry[0] -Destination $destination }
  if ((Get-NativeHash $destination) -ne $entry[2]) { throw "Invalid native build file: $destination" }
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'native/hcom/LICENSE') -Destination (Join-Path $buildDir 'hcom-LICENSE') -Force
$manifestTemp = Join-Path $nativeBin ('runtime-' + [Guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($manifestTemp, (@{ build = $buildName } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $manifestTemp -Destination (Join-Path $nativeBin 'runtime.json') -Force
Write-Output "Native runtime ready: $buildDir"

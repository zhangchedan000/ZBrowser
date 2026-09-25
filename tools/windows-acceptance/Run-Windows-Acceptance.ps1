[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$UpdateConfig,

    [Parameter()]
    [string]$E2EReport = "test-results/app-e2e-packaged.json"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw "Node.js 22 LTS x64 was not found."
}
$nodeMajor = [int]((& $node.Source -p "process.versions.node.split('.')[0]") -join "")
if ($nodeMajor -lt 22) {
    throw "Node.js 22 LTS or newer is required."
}
if (-not [Environment]::Is64BitProcess) {
    throw "Use the x64 Node.js runtime."
}

$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$release = Join-Path $ProjectRoot "release"
$unpacked = Join-Path $release "win-unpacked"
$output = Join-Path $release "windows-release-acceptance.json"
$runner = Join-Path $PSScriptRoot "signed-release.cjs"
$updateConfigPath = (Resolve-Path $UpdateConfig).Path
$e2ePath = (Resolve-Path (Join-Path $ProjectRoot $E2EReport)).Path

if (-not (Test-Path $runner)) {
    throw "Windows signed acceptance runner is missing: $runner"
}
if (-not (Test-Path (Join-Path $unpacked "ZBrowser.exe"))) {
    throw "Signed ZBrowser win-unpacked output is missing: $unpacked"
}

$arguments = @(
    $runner,
    "--release", $release,
    "--unpacked", $unpacked,
    "--e2e", $e2ePath,
    "--update-config", $updateConfigPath,
    "--output", $output
)

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Windows signed release acceptance failed. Inspect: $output"
}

Write-Host "Windows signed release acceptance passed: $output"

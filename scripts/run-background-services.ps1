param([Parameter(Mandatory = $true)][string]$Config)

$ErrorActionPreference = 'Stop'
$taskConfigPath = (Resolve-Path -LiteralPath $Config).Path
$taskConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
if (-not [System.IO.Path]::IsPathRooted($taskConfig.nodeBinary) -or -not (Test-Path -LiteralPath $taskConfig.nodeBinary -PathType Leaf)) {
    throw 'Background service configuration must name an existing absolute Node.js executable.'
}
Set-Location -LiteralPath $taskConfig.root
& $taskConfig.nodeBinary (Join-Path $PSScriptRoot 'background-supervisor.mjs') --config $taskConfigPath
exit $LASTEXITCODE

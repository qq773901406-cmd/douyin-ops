param([Parameter(Mandatory = $true)][string]$Config)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run registration with PowerShell 7.' }
function Same-Path([string]$First, [string]$Second) {
    if (-not $First -or -not $Second) { return $false }
    return [IO.Path]::GetFullPath($First).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Second).TrimEnd('\')
}
function Sid-Of([string]$Identity) {
    if ($Identity -match '^S-1-') { return $Identity }
    return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Quote-Argument([string]$Value) {
    # File paths cannot contain a literal quote; double trailing backslashes
    # because the Windows argv parser treats them specially before closing ".
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Invalid task argument.' }
    return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}
function Expected-Policy([xml]$Definition, [string]$UserSid) {
    $taskSettings = $Definition.Task.Settings
    $taskTriggers = @($Definition.Task.Triggers.ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
    $taskLogon = @($taskTriggers | Where-Object { $_.LocalName -eq 'LogonTrigger' })
    $taskTimer = @($taskTriggers | Where-Object { $_.LocalName -eq 'TimeTrigger' })
    return $taskSettings.MultipleInstancesPolicy -eq 'IgnoreNew' -and $taskSettings.ExecutionTimeLimit -eq 'PT0S' `
        -and $taskSettings.Enabled -ne 'false' -and $taskSettings.RunOnlyIfIdle -ne 'true' -and $taskSettings.RunOnlyIfNetworkAvailable -ne 'true' `
        -and $taskSettings.DisallowStartIfOnBatteries -eq 'false' -and $taskSettings.StopIfGoingOnBatteries -eq 'false' `
        -and $taskSettings.Hidden -eq 'true' -and $taskSettings.StartWhenAvailable -eq 'true' `
        -and $taskSettings.RestartOnFailure.Interval -eq 'PT1M' -and $taskSettings.RestartOnFailure.Count -eq '3' `
        -and $taskTriggers.Count -eq 2 -and $taskLogon.Count -eq 1 -and $taskTimer.Count -eq 1 `
        -and (Sid-Of $taskLogon[0].UserId) -eq $UserSid `
        -and $taskLogon[0].Enabled -ne 'false' -and $taskTimer[0].Enabled -ne 'false' `
        -and -not $taskLogon[0].EndBoundary -and -not $taskTimer[0].EndBoundary `
        -and $taskTimer[0].Repetition.Interval -eq 'PT1M' -and -not $taskTimer[0].Repetition.Duration
    # With no Duration/EndBoundary there is no repetition deadline. The Windows
    # cmdlet may still serialize StopAtDurationEnd=true; that is not a policy drift.
}

$taskConfigPath = (Resolve-Path -LiteralPath $Config).Path
$taskConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
foreach ($taskField in @('root', 'dataDir', 'nodeBinary', 'bskBinary')) {
    if (-not ($taskConfig.$taskField -is [string]) -or -not [IO.Path]::IsPathRooted($taskConfig.$taskField)) { throw "Configuration $taskField must be an absolute path." }
}
if (-not (Same-Path $taskConfig.root (Split-Path -Parent $PSScriptRoot))) { throw 'Configuration root does not own this registration script.' }
foreach ($taskSource in @('background-supervisor.mjs', 'background-service-entry.mjs', 'background-service-host.cs', 'build-background-service-host.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $taskSource) -PathType Leaf)) { throw "Missing host source: $taskSource" }
}
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskHashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskConfig.root.ToLowerInvariant()))
$taskHash = [Convert]::ToHexString($taskHashBytes).Substring(0, 12).ToLowerInvariant()
$taskName = 'Doufeng.Background.' + $taskHash
$taskOutputDirectory = Join-Path $taskConfig.dataDir 'background-services'
$taskBuildScript = Join-Path $PSScriptRoot 'build-background-service-host.ps1'
$taskBuild = & $taskBuildScript -OutputDirectory $taskOutputDirectory -CheckOnly
$taskArguments = '--config ' + (Quote-Argument $taskConfigPath)
$taskShell = Join-Path $PSHOME 'pwsh.exe'
$taskWrapper = Join-Path $PSScriptRoot 'run-background-services.ps1'
# This is the exact command line emitted by the previous registration version.
$taskLegacyArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskWrapper + '" -Config "' + $taskConfigPath + '"'
$taskExisting = $null
try { $taskExisting = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop }
catch {
    if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*') { throw }
}
$taskNeedsUpdate = $true
if ($taskExisting) {
    $taskActions = @($taskExisting.Actions)
    $taskOwnedPrincipal = (Sid-Of $taskExisting.Principal.UserId) -eq $taskSid `
        -and $taskExisting.Principal.LogonType.ToString() -in @('Interactive', 'InteractiveToken') `
        -and $taskExisting.Principal.RunLevel.ToString() -in @('Limited', 'LeastPrivilege')
    $taskLegacyAction = $taskActions.Count -eq 1 -and (Same-Path $taskActions[0].Execute $taskShell) `
        -and $taskActions[0].Arguments -ceq $taskLegacyArguments -and (Same-Path $taskActions[0].WorkingDirectory $taskConfig.root)
    $taskNewAction = $taskActions.Count -eq 1 -and (Same-Path $taskActions[0].Execute $taskBuild.executable) `
        -and $taskActions[0].Arguments -ceq $taskArguments -and (Same-Path $taskActions[0].WorkingDirectory $taskConfig.root)
    if (-not $taskOwnedPrincipal -or (-not $taskLegacyAction -and -not $taskNewAction)) {
        throw 'An existing task with this name has different ownership; left unchanged.'
    }
    $taskDefinitionXml = [xml](Export-ScheduledTask -TaskName $taskName -TaskPath '\')
    $taskNeedsUpdate = -not $taskNewAction -or -not (Expected-Policy $taskDefinitionXml $taskSid)
    if ($taskExisting.State -eq 'Running' -and ($taskNeedsUpdate -or $taskBuild.needsBuild)) {
        throw 'The owned task is running and needs host migration or rebuilding. Stop it deliberately after checking active work, then register again; no running task was stopped.'
    }
}

# Compile only after ownership and running-task checks; never replace a live host.
$taskBuild = & $taskBuildScript -OutputDirectory $taskOutputDirectory
if ($taskNeedsUpdate) {
    $taskAction = New-ScheduledTaskAction -Execute $taskBuild.executable -Argument $taskArguments -WorkingDirectory $taskConfig.root
    $taskLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
    # No RepetitionDuration means indefinite repetition. IgnoreNew makes this a
    # liveness fallback, never a restart of a healthy running task.
    $taskMinuteTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
    $taskDefinition = New-ScheduledTask -Action $taskAction -Trigger @($taskLogonTrigger, $taskMinuteTrigger) -Principal $taskPrincipal -Settings $taskSettings -Description 'Keep this local Doufeng workbench and BrowserSkill available. This task never grants publishing authorization.'
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $taskDefinition -Force:([bool]$taskExisting) | Out-Null
}
Export-ScheduledTask -TaskName $taskName -TaskPath '\' | Set-Content -LiteralPath (Join-Path $taskOutputDirectory 'task-definition.xml') -Encoding utf8
[pscustomobject]@{taskName=$taskName;user=$taskUser;config=$taskConfigPath;host=$taskBuild.executable;registeredAt=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOutputDirectory 'task-registration.json') -Encoding utf8
if (-not $taskExisting -or $taskExisting.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName -TaskPath '\' }
Get-ScheduledTask -TaskName $taskName -TaskPath '\' | Select-Object TaskName,State

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$RootPid,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ScratchPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$StopMarker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-NewUtf8File([string]$Path, [string]$Content) {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Content)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    }
    finally {
        $stream.Dispose()
    }
}

function Measure-ProcessTree([bool]$Initial) {
    $sampleAtMs = $clock.Elapsed.TotalMilliseconds
    if ($script:samples -eq 0) {
        $script:firstRssSampleMs = $sampleAtMs
    }
    $script:lastRssSampleMs = $sampleAtMs
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate -ErrorAction Stop)
    $byId = @{}
    foreach ($entry in $processes) {
        $byId[[int]$entry.ProcessId] = $entry
    }

    if ($Initial) {
        if (-not $byId.ContainsKey($RootPid)) {
            throw "Runner PID $RootPid disappeared before the initial process snapshot."
        }
        $script:tracked[$RootPid] = $byId[$RootPid].CreationDate
    }

    foreach ($memberId in @($script:tracked.Keys)) {
        if (-not $byId.ContainsKey($memberId) -or
            $byId[$memberId].CreationDate -ne $script:tracked[$memberId]) {
            $script:tracked.Remove($memberId)
        }
    }

    # Retained descendants remain anchors even after their original parent exits.
    do {
        $added = $false
        foreach ($entry in $processes) {
            $memberId = [int]$entry.ProcessId
            if ($memberId -ne $PID -and -not $script:tracked.ContainsKey($memberId) -and
                $script:tracked.ContainsKey([int]$entry.ParentProcessId)) {
                $script:tracked[$memberId] = $entry.CreationDate
                $added = $true
            }
        }
    } while ($added)

    [long]$rssBytes = 0
    [long]$rootRssBytes = 0
    $rootAlive = $false
    $descendantAlive = $false
    foreach ($memberId in @($script:tracked.Keys)) {
        $process = $null
        try {
            $process = [System.Diagnostics.Process]::GetProcessById($memberId)
            $process.Refresh()
            $workingSet = $process.WorkingSet64
            if ($process.HasExited) {
                $script:tracked.Remove($memberId)
                continue
            }
            $rssBytes += $workingSet
            if ($memberId -eq $RootPid) {
                $rootAlive = $true
                $rootRssBytes = $workingSet
            }
            else {
                $descendantAlive = $true
            }
        }
        catch {
            $samplingError = $_
            $remaining = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $memberId" -Property CreationDate -ErrorAction Stop
            if ($null -ne $remaining -and $remaining.CreationDate -eq $script:tracked[$memberId]) {
                throw $samplingError
            }
            $script:tracked.Remove($memberId)
        }
        finally {
            if ($null -ne $process) {
                $process.Dispose()
            }
        }
    }

    if ($Initial -and (-not $rootAlive -or $rootRssBytes -le 0)) {
        throw "Could not obtain a live, nonzero initial working-set sample for runner PID $RootPid."
    }
    $script:samples++
    if ($descendantAlive) {
        $script:descendantSamples++
    }
    $script:peakRssBytes = [Math]::Max($script:peakRssBytes, $rssBytes)
    return $rootAlive
}

function Measure-Scratch {
    $sampleAtMs = $clock.Elapsed.TotalMilliseconds
    if ($script:scratchSamples -eq 0) {
        $script:firstScratchSampleMs = $sampleAtMs
    }
    $script:lastScratchSampleMs = $sampleAtMs
    $script:scratchSamples++
    $scanErrors = @()
    $files = @(Get-ChildItem -LiteralPath $ScratchPath -Recurse -File -Force -ErrorAction SilentlyContinue -ErrorVariable scanErrors)
    foreach ($scanError in $scanErrors) {
        $cause = $scanError.Exception.GetBaseException()
        $disappeared = $scanError.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound -or
            $cause -is [System.IO.FileNotFoundException] -or
            $cause -is [System.IO.DirectoryNotFoundException] -or
            ($cause -is [System.IO.IOException] -and ($cause.HResult -band 65535) -in @(2, 3))
        if (-not $disappeared) {
            throw $scanError
        }
    }
    [long]$scratchBytes = 0
    [long]$spillBytes = 0
    $spillPrefix = (Join-Path $ScratchPath 'duckdb-spill') + [System.IO.Path]::DirectorySeparatorChar
    foreach ($file in $files) {
        $scratchBytes += $file.Length
        if ($file.FullName.StartsWith($spillPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $spillBytes += $file.Length
        }
    }
    $script:peakScratchBytes = [Math]::Max($script:peakScratchBytes, $scratchBytes)
    $script:peakDuckdbSpillBytes = [Math]::Max($script:peakDuckdbSpillBytes, $spillBytes)
}

try {
    if ($RootPid -eq $PID) {
        throw 'The monitor cannot monitor itself; launch it outside the runner process tree.'
    }
    $ScratchPath = [System.IO.Path]::GetFullPath($ScratchPath)
    $OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    $StopMarker = [System.IO.Path]::GetFullPath($StopMarker)
    $readyPath = $OutputPath + '.ready'
    $scratch = Get-Item -LiteralPath $ScratchPath -Force -ErrorAction Stop
    if (-not $scratch.PSIsContainer) {
        throw "Scratch path is not a directory: $ScratchPath"
    }
    if ((Test-Path -LiteralPath $OutputPath) -or (Test-Path -LiteralPath $readyPath)) {
        throw "Monitor output or readiness marker already exists: $OutputPath"
    }
    if ($OutputPath -eq $StopMarker -or $readyPath -eq $StopMarker) {
        throw 'Stop marker must differ from the monitor output and readiness paths.'
    }

    $script:tracked = @{}
    [long]$script:peakRssBytes = 0
    [long]$script:peakScratchBytes = 0
    [long]$script:peakDuckdbSpillBytes = 0
    [long]$script:samples = 0
    [long]$script:descendantSamples = 0
    [long]$script:scratchSamples = 0
    $script:firstRssSampleMs = 0.0
    $script:lastRssSampleMs = 0.0
    $script:firstScratchSampleMs = 0.0
    $script:lastScratchSampleMs = 0.0
    $rssIntervalMs = 250
    $scratchIntervalMs = 1000
    $clock = [System.Diagnostics.Stopwatch]::StartNew()

    $rootAlive = Measure-ProcessTree $true
    Measure-Scratch
    $lastScratchMs = $clock.Elapsed.TotalMilliseconds
    # Publish even if the runner exits after its successful initial sample.
    Write-NewUtf8File $readyPath 'ready'
    $nextRssMs = $clock.Elapsed.TotalMilliseconds + $rssIntervalMs

    while ($rootAlive -and -not (Test-Path -LiteralPath $StopMarker)) {
        $untilRss = $nextRssMs - $clock.Elapsed.TotalMilliseconds
        $untilScratch = $lastScratchMs + $scratchIntervalMs - $clock.Elapsed.TotalMilliseconds
        $sleepMs = [Math]::Min($untilRss, $untilScratch)
        if ($sleepMs -gt 0) {
            Start-Sleep -Milliseconds ([int][Math]::Ceiling($sleepMs))
        }
        if (Test-Path -LiteralPath $StopMarker) {
            break
        }
        if ($clock.Elapsed.TotalMilliseconds -ge $nextRssMs) {
            $sampleStartedMs = $clock.Elapsed.TotalMilliseconds
            $rootAlive = Measure-ProcessTree $false
            $nextRssMs = $sampleStartedMs + $rssIntervalMs
        }
        if ($clock.Elapsed.TotalMilliseconds - $lastScratchMs -ge $scratchIntervalMs) {
            Measure-Scratch
            $lastScratchMs = $clock.Elapsed.TotalMilliseconds
        }
    }

    $null = Measure-ProcessTree $false
    Measure-Scratch
    $clock.Stop()
    if ($script:samples -lt 2 -or $script:peakRssBytes -le 0 -or
        $script:descendantSamples -gt $script:samples -or $clock.Elapsed.TotalSeconds -le 0) {
        throw 'Resource sampling invariant failed; refusing to publish invalid metrics.'
    }
    $monitorProcess = [System.Diagnostics.Process]::GetCurrentProcess()
    $monitorCpuSeconds = $monitorProcess.TotalProcessorTime.TotalSeconds
    $monitorProcess.Dispose()
    $metrics = [ordered]@{
        sampledPeakRssBytes = $script:peakRssBytes
        sampledPeakScratchBytes = $script:peakScratchBytes
        sampledPeakDuckdbSpillBytes = $script:peakDuckdbSpillBytes
        samples = $script:samples
        descendantSamples = $script:descendantSamples
        rssIntervalMs = $rssIntervalMs
        scratchIntervalMs = $scratchIntervalMs
        elapsedSeconds = $clock.Elapsed.TotalSeconds
        monitorCpuSeconds = $monitorCpuSeconds
        scratchSamples = $script:scratchSamples
        observedMeanRssIntervalMs = ($script:lastRssSampleMs - $script:firstRssSampleMs) / ($script:samples - 1)
        observedMeanScratchIntervalMs = ($script:lastScratchSampleMs - $script:firstScratchSampleMs) / ($script:scratchSamples - 1)
    }
    Write-NewUtf8File $OutputPath ($metrics | ConvertTo-Json -Compress)
}
catch {
    [Console]::Error.WriteLine("Resource monitor failed: {0}", $_.Exception.Message)
    exit 1
}

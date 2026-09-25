import { execFile } from 'child_process'
import { getAppConfig, patchAppConfig } from '../config/app'
import { createLogger } from '../utils/logger'

const log = createLogger('HotspotTun')
const checkInterval = 2000
let timer: NodeJS.Timeout | undefined
let pending: Promise<void> = Promise.resolve()
let checkPending = false
let tunDevice = 'Mihomo'
let tunRunning = false
let boundTunGuid: string | undefined

type NetworkState = {
  physicalGuid?: string
  forwarding?: boolean
  hotspotOn?: boolean
  tunGuid?: string
}

// Windows PowerShell 5.1 has WinRT projections for the Mobile Hotspot API; pwsh 7 does not.
// Input travels through the child environment, never through interpolated PowerShell source.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = $env:CLASH_HOTSPOT_REQUEST | ConvertFrom-Json
$action = $request.action
$physical = Get-NetAdapter -Physical | Where-Object Status -eq 'Up'
$route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
  Where-Object { $physical.ifIndex -contains $_.InterfaceIndex } |
  Sort-Object RouteMetric
$outlet = if ($route) { $physical | Where-Object ifIndex -eq $route[0].InterfaceIndex | Select-Object -First 1 } else { $null }
$tun = Get-NetAdapter -IncludeHidden | Where-Object Name -eq $request.device | Select-Object -First 1
$state = @{ physicalGuid = if ($outlet) { $outlet.InterfaceGuid.ToString() } else { $null }; forwarding = $false; hotspotOn = $false; tunGuid = if ($tun) { $tun.InterfaceGuid.ToString().Trim('{}') } else { $null } }
if ($outlet) {
  $state.forwarding = (Get-NetIPInterface -InterfaceIndex $outlet.ifIndex -AddressFamily IPv4).Forwarding -eq 'Enabled'
}
if ($action -eq 'inspect' -or $action -eq 'bind') {
  [void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]
  [void][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]
  $profiles = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()
  $manager = $null
  foreach ($profile in $profiles) {
    try {
      $manager = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
      $state.hotspotOn = $manager.TetheringOperationalState.ToString() -eq 'On'
      if ($state.hotspotOn) { break }
    } catch { continue }
  }
  if ($action -eq 'bind' -and $state.hotspotOn -and $tun) {
    $target = $profiles | Where-Object { $_.NetworkAdapter -and $_.NetworkAdapter.NetworkAdapterId.ToString() -eq $state.tunGuid } | Select-Object -First 1
    if (-not $target) { throw 'TUN network profile is not available yet' }
    $manager.StopTetheringAsync() | Out-Null
    $until = (Get-Date).AddSeconds(15)
    while ($manager.TetheringOperationalState.ToString() -ne 'Off' -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 250 }
    if ($manager.TetheringOperationalState.ToString() -ne 'Off') { throw 'Hotspot did not stop' }
    $next = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($target)
    $operation = $next.StartTetheringAsync()
    $until = (Get-Date).AddSeconds(20)
    while ($next.TetheringOperationalState.ToString() -ne 'On' -and (Get-Date) -lt $until) {
      if ($operation.Status -and $operation.Status.ToString() -eq 'Error') { throw 'Hotspot start failed' }
      Start-Sleep -Milliseconds 250
    }
    if ($next.TetheringOperationalState.ToString() -ne 'On') { throw 'Hotspot did not start from TUN' }
  }
}
if ($action -eq 'disable' -or $action -eq 'restore') {
  $adapter = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid.ToString() -eq $request.guid } | Select-Object -First 1
  if (-not $adapter) { throw 'Saved physical adapter is missing' }
  Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -Forwarding $(if ($action -eq 'disable') { 'Disabled' } else { 'Enabled' })
}
$state | ConvertTo-Json -Compress
`

async function run(action: string, device: string, guid?: string): Promise<NetworkState> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, CLASH_HOTSPOT_REQUEST: JSON.stringify({ action, device, guid }) }
      },
      (error, output) => (error ? reject(error) : resolve(output))
    )
  })
  const line = stdout.trim().split(/\r?\n/).at(-1)
  if (!line) throw new Error('Windows hotspot query returned no data')
  return JSON.parse(line) as NetworkState
}

function serialize(work: () => Promise<void>): Promise<void> {
  const next = pending.then(work)
  pending = next.catch((error) => log.warn('Hotspot synchronization failed', error))
  return next
}

async function prepare(device: string): Promise<void> {
  if (process.platform !== 'win32') return
  const state = await run('probe', device)
  if (!state.physicalGuid) return
  const config = await getAppConfig()
  if (state.forwarding) {
    // Save before touching the adapter, so an application crash cannot lose the original state.
    if (!config.hotspotForwardingOriginal?.includes(state.physicalGuid)) {
      await patchAppConfig({
        hotspotForwardingOriginal: [...(config.hotspotForwardingOriginal || []), state.physicalGuid]
      })
    }
    await run('disable', device, state.physicalGuid)
  }
}

export function prepareHotspotTun(device: string): Promise<void> {
  return serialize(() => prepare(device))
}

export function watchHotspotTun(device: string): void {
  if (process.platform !== 'win32') return
  tunDevice = device
  tunRunning = true
  if (timer) clearInterval(timer)
  const check = (): void => {
    if (checkPending) return
    checkPending = true
    void serialize(async () => {
      if (!tunRunning) return
      // ICS may re-enable forwarding after hotspot startup; a live TUN then captures its own outlet traffic.
      await prepare(tunDevice)
      if (!(await getAppConfig()).hotspotTunSharing) return
      const state = await run('inspect', tunDevice)
      if (!state.hotspotOn) boundTunGuid = undefined
      if (tunRunning && state.hotspotOn && state.tunGuid && boundTunGuid !== state.tunGuid) {
        await run('bind', tunDevice)
        boundTunGuid = state.tunGuid
      }
    }).then(
      () => {
        checkPending = false
      },
      () => {
        checkPending = false
      }
    )
  }
  check()
  timer = setInterval(check, checkInterval)
  timer.unref()
}

export function refreshHotspotTun(): void {
  if (!tunRunning) return
  boundTunGuid = undefined
  watchHotspotTun(tunDevice)
}

export function stopHotspotTunWatch(): void {
  tunRunning = false
  boundTunGuid = undefined
  if (timer) clearInterval(timer)
  timer = undefined
}

export function restoreHotspotForwarding(): Promise<void> {
  stopHotspotTunWatch()
  return serialize(async () => {
    if (process.platform !== 'win32') return
    const config = await getAppConfig()
    if (!config.hotspotForwardingOriginal?.length) return
    let remaining = config.hotspotForwardingOriginal
    for (const guid of config.hotspotForwardingOriginal) {
      await run('restore', tunDevice, guid)
      remaining = remaining.filter((item) => item !== guid)
      await patchAppConfig({ hotspotForwardingOriginal: remaining })
    }
  })
}

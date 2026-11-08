import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PhysicalInterface } from '../../shared/proxyEgress'

const execFileAsync = promisify(execFile)

export const physicalInterfacesScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$physical = @(Get-NetAdapter -Physical | Where-Object { $_.HardwareInterface -and -not $_.Virtual })
$managed = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces())
$addresses = @(Get-NetIPAddress -AddressFamily IPv4)
$routes = @(Get-NetRoute -AddressFamily IPv4 | Where-Object DestinationPrefix -eq '0.0.0.0/0')
$metrics = @(Get-NetIPInterface -AddressFamily IPv4)
$result = @(foreach ($adapter in $physical) {
  $guid = $adapter.InterfaceGuid.ToString().Trim('{}')
  $nic = $managed | Where-Object { $_.Id.Trim('{}') -eq $guid } | Select-Object -First 1
  $kind = if ($nic -and $nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211) { 'wireless' } elseif ($nic -and $nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Ethernet) { 'wired' } else { 'other' }
  $ip = $addresses | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex -and $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' } | Sort-Object IPAddress | Select-Object -First 1
  $route = $routes | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex -and $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric | Select-Object -First 1
  $metric = $metrics | Where-Object InterfaceIndex -eq $adapter.ifIndex | Select-Object -First 1
  @{ guid = $guid; name = $adapter.Name; index = [int]$adapter.ifIndex; kind = $kind; physical = $true; up = ($adapter.Status.ToString() -eq 'Up'); ipv4 = $(if ($ip) { $ip.IPAddress } else { '' }); hasDefaultRoute = [bool]$route; metric = [int]$route.RouteMetric + [int]$metric.InterfaceMetric }
})
ConvertTo-Json -InputObject $result -Compress
`

export async function readPhysicalInterfaces(signal?: AbortSignal): Promise<PhysicalInterface[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(physicalInterfacesScript, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: 'utf8', signal }
  )
  const result: unknown = JSON.parse(stdout.trim())
  if (!Array.isArray(result)) throw new Error('Invalid physical interface snapshot')
  return result as PhysicalInterface[]
}

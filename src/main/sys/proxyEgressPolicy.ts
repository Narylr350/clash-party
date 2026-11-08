import { isIPv4 } from 'net'
import type { PhysicalInterface, ProxyEgressSelection } from '../../shared/proxyEgress'

export const WIRELESS_RETURN_DELAY = 10000

function usable(adapter: PhysicalInterface): boolean {
  return (
    adapter.physical &&
    adapter.up &&
    adapter.hasDefaultRoute &&
    ['wireless', 'wired'].includes(adapter.kind) &&
    isIPv4(adapter.ipv4) &&
    !['0.', '127.', '169.254.'].some((prefix) => adapter.ipv4.startsWith(prefix)) &&
    Number.isFinite(adapter.metric) &&
    Number.isInteger(adapter.index) &&
    adapter.index > 0
  )
}

export function selectionKey(selection: ProxyEgressSelection | null): string {
  return JSON.stringify(
    selection
      ? [selection.proxy, selection.direct].map((item) =>
          item ? [item.guid, item.name, item.index, item.ipv4] : null
        )
      : null
  )
}

export class ProxyEgressPolicy {
  private candidate = ''
  private observations = 0
  private returnAfter = 0
  private lostWireless = ''

  reset(): void {
    this.candidate = ''
    this.observations = 0
    this.returnAfter = 0
    this.lostWireless = ''
  }

  interruptObservation(): void {
    this.candidate = ''
    this.observations = 0
  }

  hasWirelessCandidate(): boolean {
    return this.candidate !== '' && this.observations < 2
  }

  observe(
    snapshot: PhysicalInterface[],
    current: ProxyEgressSelection | null,
    now: number,
    preferredDirect?: string
  ): ProxyEgressSelection {
    const adapters = snapshot
      .filter(usable)
      .sort((a, b) => a.metric - b.metric || a.index - b.index)
    const wired = adapters.filter((item) => item.kind === 'wired')
    const direct = wired.find((item) => item.name === preferredDirect) ?? wired[0] ?? null
    const wireless = adapters.filter((item) => item.kind === 'wireless')
    const previous = current?.proxy?.kind === 'wireless' ? current.proxy : null
    const retained = previous && wireless.find((item) => item.guid === previous.guid)
    if (retained) {
      this.candidate = ''
      this.observations = 0
      this.lostWireless = ''
      return { proxy: retained, direct: direct ?? retained }
    }
    if (previous && this.lostWireless !== previous.guid) {
      this.returnAfter = now + WIRELESS_RETURN_DELAY
      this.lostWireless = previous.guid
    }
    const next = wireless[0]
    const key = next ? selectionKey({ proxy: next, direct: null }) : ''
    this.observations = key && key === this.candidate ? this.observations + 1 : key ? 1 : 0
    this.candidate = key
    if (next && this.observations >= 2 && now >= this.returnAfter) {
      this.lostWireless = ''
      return { proxy: next, direct: direct ?? next }
    }
    return { proxy: direct, direct }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function applyProxyEgress<T extends object>(
  profile: T,
  selection: ProxyEgressSelection | null
): T {
  if (!selection) return profile
  const next = structuredClone(profile) as Record<string, unknown>
  if (selection.direct) next['interface-name'] = selection.direct.name
  if (Array.isArray(next.proxies)) {
    for (const node of next.proxies) {
      if (!record(node)) continue
      const type = String(node.type).toLowerCase()
      if (type === 'direct') {
        if (selection.direct) node['interface-name'] = selection.direct.name
      } else if (
        !['dns', 'reject', 'reject-drop', 'pass', 'rematch', 'compatible'].includes(type)
      ) {
        if (selection.proxy) node['interface-name'] = selection.proxy.name
      }
    }
  }
  if (selection.proxy && record(next['proxy-providers'])) {
    for (const provider of Object.values(next['proxy-providers'])) {
      if (!record(provider)) continue
      provider.override = {
        ...(record(provider.override) ? provider.override : {}),
        'interface-name': selection.proxy.name
      }
    }
  }
  return next as T
}

export function proxyConnectionIds(
  connections: { id: string; chains?: string[] }[],
  proxies: Record<string, { type: string; all?: unknown }>
): string[] {
  const remote = new Set(
    Object.entries(proxies)
      .filter(
        ([, item]) =>
          !item.all &&
          ![
            'direct',
            'reject',
            'rejectdrop',
            'pass',
            'dns',
            'compatible',
            'selector',
            'urltest',
            'fallback',
            'loadbalance',
            'relay',
            'smart'
          ].includes(item.type.toLowerCase())
      )
      .map(([name]) => name)
  )
  return connections
    .filter((item) => item.chains?.some((name) => remote.has(name)))
    .map((item) => item.id)
}

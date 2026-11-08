import { describe, expect, it } from 'vitest'
import type { PhysicalInterface } from '../../shared/proxyEgress'
import {
  applyProxyEgress,
  ProxyEgressPolicy,
  proxyConnectionIds,
  selectionKey
} from './proxyEgressPolicy'

export function adapter(patch: Partial<PhysicalInterface> = {}): PhysicalInterface {
  return {
    guid: 'wired',
    name: 'Ethernet',
    index: 1,
    kind: 'wired',
    physical: true,
    up: true,
    ipv4: '10.0.0.2',
    hasDefaultRoute: true,
    metric: 10,
    ...patch
  }
}

const wired = adapter()
const wifi = adapter({
  guid: 'wifi',
  name: 'Wi-Fi',
  index: 2,
  kind: 'wireless',
  ipv4: '192.168.43.2',
  metric: 40
})

describe('proxy egress selection', () => {
  it('requires two observations for wireless while retaining wired DIRECT', () => {
    const policy = new ProxyEgressPolicy()
    const first = policy.observe([wired, wifi], null, 0)
    expect(first).toEqual({ proxy: wired, direct: wired })
    expect(policy.observe([wired, wifi], first, 2000)).toEqual({ proxy: wifi, direct: wired })
  })

  it.each([
    { physical: false },
    { up: false },
    { hasDefaultRoute: false },
    { ipv4: '169.254.1.2' },
    { ipv4: '127.0.0.1' },
    { ipv4: '0.0.0.0' },
    { ipv4: '2001:db8::1' },
    { ipv4: 'invalid' },
    { index: 0 },
    { metric: NaN },
    { kind: 'other' as const }
  ])('rejects unusable or virtual interfaces: %j', (patch) => {
    const policy = new ProxyEgressPolicy()
    const snapshot = [adapter({ ...wifi, ...patch })]
    policy.observe(snapshot, null, 0)
    expect(policy.observe(snapshot, null, 2000)).toEqual({ proxy: null, direct: null })
  })

  it('falls back immediately and waits ten seconds before returning', () => {
    const policy = new ProxyEgressPolicy()
    policy.observe([wired, wifi], null, 0)
    const active = policy.observe([wired, wifi], null, 2000)
    const fallback = policy.observe([wired], active, 4000)
    expect(fallback.proxy).toEqual(wired)
    expect(policy.observe([wired, wifi], fallback, 6000).proxy).toEqual(wired)
    expect(policy.observe([wired, wifi], fallback, 8000).proxy).toEqual(wired)
    expect(policy.observe([wired, wifi], fallback, 13999).proxy).toEqual(wired)
    expect(policy.observe([wired, wifi], fallback, 14000).proxy).toEqual(wifi)
  })

  it('uses metric and index for the first choice but keeps a usable active wireless adapter', () => {
    const policy = new ProxyEgressPolicy()
    const other = adapter({ ...wifi, guid: 'wifi-2', name: 'Wi-Fi 2', index: 3, metric: 20 })
    policy.observe([wifi, other], null, 0)
    expect(policy.observe([wifi, other], null, 2000).proxy).toEqual(other)
    expect(policy.observe([wifi, other], { proxy: wifi, direct: wifi }, 4000).proxy).toEqual(wifi)
    const tied = new ProxyEgressPolicy()
    const snapshot = [adapter({ ...other, metric: 40 }), wifi]
    tied.observe(snapshot, null, 0)
    expect(tied.observe(snapshot, null, 2000).proxy).toEqual(wifi)
  })

  it('uses wireless for DIRECT only when no wired connection is available', () => {
    const policy = new ProxyEgressPolicy()
    policy.observe([wifi], null, 0)
    const active = policy.observe([wifi], null, 2000)
    expect(active).toEqual({ proxy: wifi, direct: wifi })
    expect(policy.observe([wired, wifi], active, 4000)).toEqual({ proxy: wifi, direct: wired })
    expect(policy.observe([], active, 6000)).toEqual({ proxy: null, direct: null })
  })

  it('honors an existing usable wired binding for DIRECT', () => {
    const policy = new ProxyEgressPolicy()
    const other = adapter({ guid: 'wired-2', name: 'Ethernet 2', index: 4, metric: 100 })
    expect(policy.observe([wired, other], null, 0, 'Ethernet 2').direct).toEqual(other)
  })

  it('updates addresses without reacting to metric-only changes', () => {
    const policy = new ProxyEgressPolicy()
    const active = { proxy: wifi, direct: wired }
    expect(
      selectionKey(policy.observe([wired, adapter({ ...wifi, metric: 200 })], active, 0))
    ).toBe(selectionKey(active))
    expect(
      selectionKey(policy.observe([wired, adapter({ ...wifi, ipv4: '192.168.43.3' })], active, 0))
    ).not.toBe(selectionKey(active))
  })

  it('does not count a failed observation toward wireless readiness', () => {
    const policy = new ProxyEgressPolicy()
    policy.observe([wired, wifi], null, 0)
    policy.interruptObservation()
    expect(policy.observe([wired, wifi], null, 2000).proxy).toEqual(wired)
    expect(policy.observe([wired, wifi], null, 4000).proxy).toEqual(wifi)
  })
})

describe('runtime egress binding', () => {
  const profile = {
    'interface-name': 'Ethernet',
    dns: {
      nameserver: ['https://1.1.1.1/dns-query#Proxy'],
      'nameserver-policy': { 'geosite:cn': 'https://doh.pub/dns-query#DIRECT' }
    },
    tun: { enable: true, 'auto-detect-interface': false },
    proxies: ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'wireguard'].map((type) => ({
      name: type,
      type,
      server: 'example.test',
      'interface-name': 'original'
    })),
    'proxy-providers': {
      subscription: {
        type: 'http',
        url: 'https://example.test/sub',
        override: { udp: true, 'additional-prefix': 'Prefix' }
      }
    },
    'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['ss', 'DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,cn,DIRECT', 'MATCH,Proxy']
  }

  it('does nothing when disabled, preserving original bindings', () => {
    expect(applyProxyEgress(profile, null)).toBe(profile)
  })

  it('binds all remote node types and providers without mutating input or routing/DNS', () => {
    const original = structuredClone(profile)
    const next = applyProxyEgress(profile, { proxy: wifi, direct: wired })
    expect(profile).toEqual(original)
    expect(next.proxies.every((node) => node['interface-name'] === 'Wi-Fi')).toBe(true)
    expect(next['proxy-providers'].subscription.override).toEqual({
      udp: true,
      'additional-prefix': 'Prefix',
      'interface-name': 'Wi-Fi'
    })
    expect(next['interface-name']).toBe('Ethernet')
    for (const key of ['dns', 'tun', 'rules', 'proxy-groups'] as const)
      expect(next[key]).toEqual(profile[key])
  })

  it('binds explicit DIRECT nodes separately and leaves DNS/REJECT strategies alone', () => {
    const input = {
      proxies: [
        { type: 'direct', name: 'Local' },
        { type: 'dns', name: 'DNS' },
        { type: 'reject', name: 'Block' }
      ]
    }
    const next = applyProxyEgress(input, { proxy: wifi, direct: wired })
    expect(next.proxies).toEqual([
      { type: 'direct', name: 'Local', 'interface-name': 'Ethernet' },
      { type: 'dns', name: 'DNS' },
      { type: 'reject', name: 'Block' }
    ])
  })

  it('regenerates bindings after fallback, refresh, and disabling without persisting them', () => {
    expect(
      applyProxyEgress(profile, { proxy: wired, direct: wired }).proxies[0]['interface-name']
    ).toBe('Ethernet')
    expect(applyProxyEgress(profile, { proxy: wifi, direct: wifi })['interface-name']).toBe('Wi-Fi')
    expect(applyProxyEgress(profile, null).proxies[0]['interface-name']).toBe('original')
    const refreshed = {
      ...profile,
      proxies: [
        ...profile.proxies,
        { name: 'new', type: 'ss', server: 'new.test', 'interface-name': 'original' }
      ]
    }
    expect(
      applyProxyEgress(refreshed, { proxy: wifi, direct: wired }).proxies.at(-1)?.['interface-name']
    ).toBe('Wi-Fi')
  })

  it('selects only established proxy connections for reconnection', () => {
    const ids = proxyConnectionIds(
      [
        { id: 'proxy', chains: ['ss', 'Proxy'] },
        { id: 'direct', chains: ['DIRECT'] },
        { id: 'custom-direct', chains: ['Local', 'Proxy'] },
        { id: 'unknown', chains: ['missing'] },
        { id: 'incomplete-group', chains: ['DIRECT', 'Smart'] }
      ],
      {
        ss: { type: 'Shadowsocks' },
        DIRECT: { type: 'Direct' },
        Local: { type: 'Direct' },
        Proxy: { type: 'Selector', all: ['ss', 'Local'] },
        Smart: { type: 'Smart' }
      }
    )
    expect(ids).toEqual(['proxy'])
  })
})

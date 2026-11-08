import { mkdtemp, mkdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from '../utils/yaml'
import { defaultSimpleDraft } from '../../shared/simple-config'
import { generateProfile, getRuntimeConfig } from './factory'
import { setProxyEgressSelection } from './proxyEgressState'

const mocks = vi.hoisted(() => ({
  directory: '',
  simple: false,
  base: {} as Record<string, unknown>
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../utils/age', () => ({ decryptAgeContent: async (value: string) => value }))
vi.mock('../utils/dirs', () => ({
  mihomoWorkDir: () => mocks.directory,
  mihomoWorkConfigPath: () => path.join(mocks.directory, 'work.yaml'),
  mihomoProfileWorkDir: () => mocks.directory,
  simpleOutputPath: () => path.join(mocks.directory, 'simple.yaml'),
  simpleConfigPath: () => path.join(mocks.directory, 'simple-source.yaml'),
  rulePath: () => path.join(mocks.directory, 'absent-rules.yaml'),
  overridePath: () => path.join(mocks.directory, 'absent-override.yaml')
}))
vi.mock('../config', () => ({
  getAppConfig: async () => ({
    operationMode: mocks.simple ? 'simple' : 'standard',
    controlDns: false,
    controlSniff: false
  }),
  getProfileConfig: async () => ({ current: 'current' }),
  getProfileItem: async () => ({ override: [] }),
  getProfile: async () => structuredClone(mocks.base),
  getControledMihomoConfig: async () => ({ 'interface-name': 'Ethernet' }),
  getOverrideConfig: async () => ({ items: [] }),
  getOverrideItem: vi.fn(),
  getOverride: vi.fn()
}))
vi.mock('./dnsOverrideGuard', () => ({
  evaluateDnsOverrideGuard: () => ({
    controlDns: false,
    autoDisabled: false,
    fingerprint: null,
    request: null
  })
}))
vi.mock('../simple/subscriptions', () => ({ resolveSimpleDraft: async (draft: unknown) => draft }))
vi.mock('../simple/service', () => ({
  compileSimpleRuntime: async (options: Record<string, unknown>) => {
    const { compileAndWriteSimple } = await import('../simple/store')
    const draft = defaultSimpleDraft()
    draft.modules.proxies = JSON.stringify(mocks.base.proxies)
    draft.modules.general += 'interface-name: Ethernet\n'
    return compileAndWriteSimple(
      { version: 2, revision: 1, draft, published: draft },
      true,
      {},
      options
    )
  }
}))

const wired = {
  guid: 'wired',
  name: 'Ethernet',
  index: 1,
  kind: 'wired' as const,
  physical: true,
  up: true,
  ipv4: '10.0.0.2',
  hasDefaultRoute: true,
  metric: 10
}
const wifi = {
  ...wired,
  guid: 'wifi',
  name: 'Wi-Fi',
  index: 2,
  kind: 'wireless' as const,
  ipv4: '192.168.43.2'
}

beforeEach(async () => {
  mocks.directory = await mkdtemp(path.join(tmpdir(), 'clash-compile-egress-'))
  await mkdir(mocks.directory, { recursive: true })
  mocks.simple = false
  mocks.base = {
    proxies: [
      {
        name: 'Node',
        type: 'ss',
        server: '198.51.100.1',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'fixture',
        'interface-name': 'original'
      }
    ],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['Node', 'DIRECT'] }],
    rules: ['MATCH,PROXY'],
    dns: { enable: true, nameserver: ['https://doh.pub/dns-query#DIRECT'] }
  }
  setProxyEgressSelection(null)
})
afterEach(async () => {
  setProxyEgressSelection(null)
  await rm(mocks.directory, { recursive: true, force: true })
})

describe.each(['standard', 'simple'])('%s runtime egress compilation', (mode) => {
  it('adds bindings to generated output only and restores original values when disabled', async () => {
    mocks.simple = mode === 'simple'
    const base = structuredClone(mocks.base)
    setProxyEgressSelection({ proxy: wifi, direct: wired })
    await generateProfile()
    const bound = parse(await readFile(path.join(mocks.directory, 'work.yaml'), 'utf8'))
    expect(bound['interface-name']).toBe('Ethernet')
    expect(bound.proxies[0]['interface-name']).toBe('Wi-Fi')
    expect(mocks.base).toEqual(base)
    setProxyEgressSelection(null)
    await generateProfile()
    const restored = parse(await readFile(path.join(mocks.directory, 'work.yaml'), 'utf8'))
    expect(restored.proxies[0]['interface-name']).toBe('original')
    expect(restored.rules).toEqual(bound.rules)
    expect(restored.dns).toEqual(bound.dns)
    expect(restored['proxy-groups']).toEqual(bound['proxy-groups'])
  })

  it('validates a candidate without replacing active output or cached runtime', async () => {
    mocks.simple = mode === 'simple'
    await generateProfile()
    const work = path.join(mocks.directory, 'work.yaml')
    const active = await readFile(work, 'utf8')
    const cached = structuredClone(await getRuntimeConfig())
    const candidate = path.join(mocks.directory, 'candidate.yaml')
    await generateProfile(undefined, {
      outputPath: candidate,
      updateRuntimeConfig: false,
      egressSelection: { proxy: wifi, direct: wired }
    })
    expect(await readFile(work, 'utf8')).toBe(active)
    expect(await getRuntimeConfig()).toEqual(cached)
    expect(parse(await readFile(candidate, 'utf8')).proxies[0]['interface-name']).toBe('Wi-Fi')
  })
})

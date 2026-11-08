import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyEgressSelection } from '../../shared/proxyEgress'
import { getProxyEgressSelection, setProxyEgressSelection } from '../core/proxyEgressState'
import { applyProxyEgressChange } from './proxyEgress'

const mocks = vi.hoisted(() => ({
  directory: '',
  running: true,
  simple: false,
  generate: vi.fn(),
  check: vi.fn(),
  reload: vi.fn(),
  close: vi.fn(),
  prepare: vi.fn(),
  get: vi.fn(),
  proxies: vi.fn(),
  profileItem: vi.fn()
}))
vi.mock('../utils/dirs', () => ({ mihomoWorkDir: () => mocks.directory }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
vi.mock('../config/app', () => ({
  getAppConfig: async () => ({
    core: 'mihomo-smart',
    operationMode: mocks.simple ? 'simple' : 'standard'
  }),
  patchAppConfig: vi.fn()
}))
vi.mock('../config/controledMihomo', () => ({
  getControledMihomoConfig: async () => ({ tun: { enable: true, device: 'Mihomo' } })
}))
vi.mock('../config/profile', () => ({
  getProfileConfig: async () => ({ current: 'current' }),
  getProfileItem: mocks.profileItem
}))
vi.mock('../core/manager', () => ({
  hasCoreProcess: () => mocks.running,
  checkProfileConfig: mocks.check
}))
vi.mock('../core/factory', () => ({ generateProfile: mocks.generate }))
vi.mock('../core/mihomoApi', () => ({
  getAxios: async () => ({ get: mocks.get }),
  mihomoHotReloadConfig: mocks.reload,
  mihomoCloseConnection: mocks.close,
  mihomoProxies: mocks.proxies
}))
vi.mock('./hotspotTun', () => ({ prepareHotspotTun: mocks.prepare }))

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
const previous: ProxyEgressSelection = { proxy: wired, direct: wired }
const next: ProxyEgressSelection = { proxy: wifi, direct: wired }

beforeEach(async () => {
  vi.resetAllMocks()
  mocks.directory = await mkdtemp(path.join(tmpdir(), 'clash-egress-test-'))
  mocks.running = true
  mocks.simple = false
  mocks.profileItem.mockResolvedValue({})
  mocks.get.mockResolvedValue({
    connections: [
      { id: 'proxy', chains: ['Node', 'Proxy'] },
      { id: 'direct', chains: ['DIRECT'] }
    ]
  })
  mocks.proxies.mockResolvedValue({
    proxies: {
      Node: { type: 'Shadowsocks' },
      Proxy: { type: 'Selector', all: ['Node'] },
      DIRECT: { type: 'Direct' }
    }
  })
  mocks.generate.mockImplementation(async (_config, options) => {
    await writeFile(options.outputPath, 'rules: ["MATCH,DIRECT"]')
  })
  setProxyEgressSelection(previous)
})

afterEach(async () => {
  setProxyEgressSelection(null)
  await rm(mocks.directory, { recursive: true, force: true })
})

describe('validated proxy egress application', () => {
  it('validates a separate candidate, applies through the app, and closes only proxy connections', async () => {
    await applyProxyEgressChange(next, new AbortController().signal)
    expect(mocks.generate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ updateRuntimeConfig: false, egressSelection: next })
    )
    expect(mocks.check).toHaveBeenCalledWith(
      expect.any(String),
      'mihomo-smart',
      undefined,
      expect.objectContaining({ timeoutMs: 15000 })
    )
    expect(mocks.check.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reload.mock.invocationCallOrder[0]
    )
    expect(mocks.prepare).toHaveBeenCalledWith('Mihomo')
    expect(mocks.reload).toHaveBeenCalledWith({ allowRestart: false })
    expect(mocks.close.mock.calls).toEqual([['proxy']])
    expect(getProxyEgressSelection()).toEqual(next)
    await expect(readFile(mocks.generate.mock.calls[0][1].outputPath)).rejects.toThrow()
  })

  it('does not touch the running configuration when candidate validation fails', async () => {
    mocks.check.mockRejectedValueOnce(new Error('Rejected by kernel'))
    await expect(applyProxyEgressChange(next, new AbortController().signal)).rejects.toThrow(
      'previous configuration retained'
    )
    expect(getProxyEgressSelection()).toEqual(previous)
    expect(mocks.reload).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('restores the prior overlay and reloads it once if applying fails', async () => {
    mocks.reload.mockRejectedValueOnce(new Error('PUT failed')).mockResolvedValueOnce(undefined)
    await expect(applyProxyEgressChange(next, new AbortController().signal)).rejects.toThrow(
      'previous configuration retained'
    )
    expect(getProxyEgressSelection()).toEqual(previous)
    expect(mocks.reload.mock.calls).toEqual([[{ allowRestart: false }], [{ allowRestart: false }]])
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('reports rollback failure without repeatedly restarting or applying', async () => {
    mocks.reload.mockRejectedValue(new Error('API unavailable'))
    await expect(applyProxyEgressChange(next, new AbortController().signal)).rejects.toThrow(
      'rollback failed'
    )
    expect(mocks.reload).toHaveBeenCalledTimes(2)
    expect(mocks.reload.mock.calls.every(([options]) => options.allowRestart === false)).toBe(true)
  })

  it('ignores a candidate whose setting was cancelled during validation', async () => {
    const abort = new AbortController()
    mocks.check.mockImplementationOnce(async () => {
      abort.abort()
    })
    await expect(applyProxyEgressChange(next, abort.signal)).rejects.toThrow('cancelled')
    expect(getProxyEgressSelection()).toEqual(previous)
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('does not start a stopped core and keeps the selection ready for its next startup', async () => {
    mocks.running = false
    await applyProxyEgressChange(next, new AbortController().signal)
    expect(getProxyEgressSelection()).toEqual(next)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('does not restart a core that stopped during validation', async () => {
    mocks.check.mockImplementationOnce(async () => {
      mocks.running = false
    })
    await applyProxyEgressChange(next, new AbortController().signal)
    expect(getProxyEgressSelection()).toEqual(next)
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('does not load standard subscription credentials in simple mode', async () => {
    mocks.simple = true
    await applyProxyEgressChange(next, new AbortController().signal)
    expect(mocks.profileItem).not.toHaveBeenCalled()
  })
})

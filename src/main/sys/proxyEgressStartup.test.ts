import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  generate: vi.fn(),
  check: vi.fn(),
  enabled: true
}))
vi.mock('../config/app', () => ({
  getAppConfig: async () => ({ preferWirelessForProxy: mocks.enabled }),
  patchAppConfig: vi.fn()
}))
vi.mock('../config/controledMihomo', () => ({
  getControledMihomoConfig: async () => ({ 'interface-name': 'Ethernet' })
}))
vi.mock('../config/profile', () => ({ getProfileConfig: vi.fn(), getProfileItem: vi.fn() }))
vi.mock('../core/manager', () => ({ hasCoreProcess: () => false, checkProfileConfig: mocks.check }))
vi.mock('../core/factory', () => ({ generateProfile: mocks.generate }))
vi.mock('../core/mihomoApi', () => ({
  getAxios: vi.fn(),
  mihomoCloseConnection: vi.fn(),
  mihomoHotReloadConfig: vi.fn(),
  mihomoProxies: vi.fn()
}))
vi.mock('../utils/dirs', () => ({ mihomoWorkDir: () => 'unused' }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
vi.mock('./hotspotTun', () => ({ prepareHotspotTun: vi.fn() }))
vi.mock('./physicalInterfaces', () => ({ readPhysicalInterfaces: mocks.read }))

const wifi = {
  guid: 'wifi',
  name: 'Wi-Fi',
  index: 2,
  kind: 'wireless',
  physical: true,
  up: true,
  ipv4: '192.168.43.2',
  hasDefaultRoute: true,
  metric: 25
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.enabled = true
  mocks.read.mockResolvedValue([wifi])
})
afterEach(async () => {
  const { stopProxyEgress } = await import('./proxyEgress')
  stopProxyEgress()
  await Promise.resolve()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('persisted wireless priority at application startup', () => {
  it('selects wireless before a stopped core generates its initial configuration', async () => {
    const { initializeProxyEgress, getProxyEgressStatus } = await import('./proxyEgress')
    const initializing = initializeProxyEgress(true)
    await vi.advanceTimersByTimeAsync(2000)
    await initializing
    const { getProxyEgressSelection } = await import('../core/proxyEgressState')
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(getProxyEgressSelection()).toMatchObject({ proxy: wifi, direct: wifi })
    expect(await getProxyEgressStatus()).toMatchObject({ enabled: true, phase: 'wireless' })
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.check).not.toHaveBeenCalled()
  })

  it('does not delay or probe for the default disabled setting', async () => {
    mocks.enabled = false
    const { initializeProxyEgress } = await import('./proxyEgress')
    await initializeProxyEgress(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not block core startup when there is no physical default route', async () => {
    mocks.read.mockResolvedValue([])
    const { initializeProxyEgress, getProxyEgressStatus } = await import('./proxyEgress')
    await expect(initializeProxyEgress(true)).resolves.toBeUndefined()
    expect(await getProxyEgressStatus()).toMatchObject({ phase: 'waiting', proxyInterface: null })
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('retains the original startup path when interface inspection fails', async () => {
    mocks.read.mockRejectedValue(new Error('CIM unavailable'))
    const { initializeProxyEgress, getProxyEgressStatus } = await import('./proxyEgress')
    await expect(initializeProxyEgress(true)).resolves.toBeUndefined()
    expect(await getProxyEgressStatus()).toMatchObject({ phase: 'error', proxyInterface: null })
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})

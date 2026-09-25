import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  prepareHotspotTun,
  restoreHotspotForwarding,
  stopHotspotTunWatch,
  watchHotspotTun
} from './hotspotTun'

const mocks = vi.hoisted(() => ({
  config: { hotspotTunSharing: true, hotspotForwardingOriginal: [] as string[] },
  actions: [] as string[],
  forwarding: true,
  hotspotOn: true,
  tunGuid: 'tun-1',
  physicalGuid: 'physical-1' as string | undefined
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      options: { env: Record<string, string> },
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const { action } = JSON.parse(options.env.CLASH_HOTSPOT_REQUEST) as { action: string }
      mocks.actions.push(action)
      if (action === 'disable') mocks.forwarding = false
      if (action === 'restore') mocks.forwarding = true
      callback(
        null,
        JSON.stringify({
          physicalGuid: mocks.physicalGuid,
          forwarding: mocks.forwarding,
          hotspotOn: mocks.hotspotOn,
          tunGuid: mocks.tunGuid
        })
      )
    }
  )
}))
vi.mock('../config/app', () => ({
  getAppConfig: vi.fn(async () => mocks.config),
  patchAppConfig: vi.fn(async (patch: Record<string, unknown>) =>
    Object.assign(mocks.config, patch)
  )
}))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))

describe('Windows TUN hotspot sharing', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.config.hotspotTunSharing = true
    mocks.config.hotspotForwardingOriginal = []
    mocks.actions = []
    mocks.forwarding = true
    mocks.hotspotOn = true
    mocks.tunGuid = 'tun-1'
    mocks.physicalGuid = 'physical-1'
  })
  afterEach(() => {
    stopHotspotTunWatch()
    vi.restoreAllMocks()
  })

  it('persists the physical forwarding state before changing it and restores it after stop', async () => {
    await prepareHotspotTun('Mihomo')
    expect(mocks.actions).toEqual(['probe', 'disable'])
    expect(mocks.config.hotspotForwardingOriginal).toEqual(['physical-1'])
    await restoreHotspotForwarding()
    expect(mocks.actions.at(-1)).toBe('restore')
    expect(mocks.config.hotspotForwardingOriginal).toEqual([])
  })

  it('protects the physical outlet without opting into hotspot rebinding', async () => {
    mocks.config.hotspotTunSharing = false
    watchHotspotTun('Mihomo')
    await vi.waitFor(() => expect(mocks.actions).toContain('disable'))
    expect(mocks.config.hotspotForwardingOriginal).toEqual(['physical-1'])
    expect(mocks.actions).not.toContain('bind')
  })

  it('catches forwarding enabled after the hotspot starts', async () => {
    mocks.config.hotspotTunSharing = false
    mocks.forwarding = false
    watchHotspotTun('Mihomo')
    await vi.waitFor(() => expect(mocks.actions).toContain('probe'))
    expect(mocks.actions).not.toContain('disable')

    mocks.forwarding = true
    watchHotspotTun('Mihomo')
    await vi.waitFor(() => expect(mocks.actions).toContain('disable'))
    expect(mocks.actions).not.toContain('bind')
  })

  it('does not block TUN startup while no physical outlet is available', async () => {
    mocks.physicalGuid = undefined
    await expect(prepareHotspotTun('Mihomo')).resolves.toBeUndefined()
    expect(mocks.actions).toEqual(['probe'])
  })

  it('binds only once for a stable hotspot and TUN adapter', async () => {
    mocks.forwarding = false
    watchHotspotTun('Mihomo')
    await vi.waitFor(() =>
      expect(mocks.actions.filter((action) => action === 'bind')).toHaveLength(1)
    )
    watchHotspotTun('Mihomo')
    await vi.waitFor(() =>
      expect(mocks.actions.filter((action) => action === 'inspect')).toHaveLength(2)
    )
    expect(mocks.actions.filter((action) => action === 'bind')).toHaveLength(1)

    mocks.hotspotOn = false
    watchHotspotTun('Mihomo')
    await vi.waitFor(() =>
      expect(mocks.actions.filter((action) => action === 'inspect')).toHaveLength(3)
    )
    mocks.hotspotOn = true
    watchHotspotTun('Mihomo')
    await vi.waitFor(() =>
      expect(mocks.actions.filter((action) => action === 'bind')).toHaveLength(2)
    )
  })
})

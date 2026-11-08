import { describe, expect, it, vi } from 'vitest'
import type { PhysicalInterface, ProxyEgressSelection } from '../../shared/proxyEgress'
import { ProxyEgressController } from './proxyEgressController'

const wired: PhysicalInterface = {
  guid: 'wired',
  name: 'Ethernet',
  index: 1,
  kind: 'wired',
  physical: true,
  up: true,
  ipv4: '10.0.0.2',
  hasDefaultRoute: true,
  metric: 10
}
const wifi: PhysicalInterface = {
  ...wired,
  guid: 'wifi',
  name: 'Wi-Fi',
  index: 2,
  kind: 'wireless',
  ipv4: '192.168.43.2',
  metric: 50
}

function setup(enabled = true) {
  const dependencies = {
    read: vi.fn(async (): Promise<PhysicalInterface[]> => [wired, wifi]),
    preferredDirect: vi.fn(async (): Promise<string | undefined> => 'Ethernet'),
    apply: vi.fn(
      async (_selection: ProxyEgressSelection | null, _signal: AbortSignal): Promise<void> =>
        undefined
    ),
    persist: vi.fn(async (_enabled: boolean): Promise<void> => undefined),
    now: () => 0
  }
  return { dependencies, controller: new ProxyEgressController(dependencies, enabled) }
}

describe('wireless preference controller', () => {
  it('does no probing or application when disabled', async () => {
    const { controller, dependencies } = setup(false)
    await controller.poll()
    expect(dependencies.read).not.toHaveBeenCalled()
    expect(dependencies.apply).not.toHaveBeenCalled()
    expect(controller.status().phase).toBe('disabled')
  })

  it('persists the switch, debounces wireless, and avoids identical reloads', async () => {
    const { controller, dependencies } = setup(false)
    await controller.setEnabled(true)
    expect(dependencies.persist).toHaveBeenCalledWith(true)
    await controller.poll()
    expect(controller.status().phase).toBe('wired')
    await controller.poll()
    expect(controller.status()).toMatchObject({
      phase: 'wireless',
      proxyInterface: 'Wi-Fi',
      directInterface: 'Ethernet'
    })
    await controller.poll()
    expect(dependencies.apply).toHaveBeenCalledTimes(2)
  })

  it('retains the applied outlet on snapshot errors and clears transient read errors', async () => {
    const { controller, dependencies } = setup()
    await controller.poll()
    await controller.poll()
    dependencies.read.mockRejectedValueOnce(new Error('CIM unavailable'))
    await controller.poll()
    expect(controller.status()).toMatchObject({ phase: 'error', proxyInterface: 'Wi-Fi' })
    expect(dependencies.apply).toHaveBeenCalledTimes(2)
    await controller.poll()
    expect(controller.status().phase).toBe('wireless')
  })

  it('keeps the previous selection on validation/application errors and does not loop', async () => {
    const { controller, dependencies } = setup()
    await controller.poll()
    dependencies.apply.mockRejectedValueOnce(new Error('Candidate rejected'))
    await controller.poll()
    await controller.poll()
    expect(controller.status()).toMatchObject({ phase: 'error', proxyInterface: 'Ethernet' })
    expect(dependencies.apply).toHaveBeenCalledTimes(2)
  })

  it('does not enable the feature when persistence fails', async () => {
    const { controller, dependencies } = setup(false)
    dependencies.persist.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(controller.setEnabled(true)).rejects.toThrow('Disk unavailable')
    await controller.poll()
    expect(controller.status().enabled).toBe(false)
    expect(dependencies.read).not.toHaveBeenCalled()
  })

  it('restores the prior selection if disabling cannot be persisted', async () => {
    const { controller, dependencies } = setup()
    await controller.poll()
    await controller.poll()
    dependencies.persist.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(controller.setEnabled(false)).rejects.toThrow('Disk unavailable')
    expect(
      dependencies.apply.mock.calls.slice(-2).map(([selection]) => selection?.proxy?.name ?? null)
    ).toEqual([null, 'Wi-Fi'])
    expect(controller.status().enabled).toBe(true)
  })

  it('discards a read completed after the user turns the switch off', async () => {
    const { controller, dependencies } = setup()
    let resolveRead: (value: PhysicalInterface[]) => void = () => undefined
    dependencies.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )
    const poll = controller.poll()
    await controller.setEnabled(false)
    resolveRead([wired, wifi])
    await poll
    expect(dependencies.apply.mock.calls.map(([selection]) => selection)).toEqual([null])
    expect(controller.status().phase).toBe('disabled')
  })

  it('coalesces overlapping reads and ignores disposal-time results', async () => {
    const { controller, dependencies } = setup()
    let resolveRead: (value: PhysicalInterface[]) => void = () => undefined
    dependencies.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )
    const poll = controller.poll()
    await controller.poll()
    expect(dependencies.read).toHaveBeenCalledTimes(1)
    controller.dispose()
    resolveRead([wired, wifi])
    await poll
    expect(dependencies.apply).not.toHaveBeenCalled()
  })

  it('aborts an in-flight application before executing disable', async () => {
    const { controller, dependencies } = setup()
    let started: () => void = () => undefined
    const applying = new Promise<void>((resolve) => {
      started = resolve
    })
    dependencies.apply.mockImplementationOnce(async (_selection, signal) => {
      started()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      })
    })
    const poll = controller.poll()
    await applying
    await controller.setEnabled(false)
    await poll
    expect(dependencies.apply.mock.calls[0][1].aborted).toBe(true)
    expect(controller.status().phase).toBe('disabled')
    expect(dependencies.apply.mock.calls.at(-1)?.[0]).toBeNull()
  })
})

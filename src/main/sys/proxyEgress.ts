import { mkdir, rm } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { getAppConfig, patchAppConfig } from '../config/app'
import { getControledMihomoConfig } from '../config/controledMihomo'
import { getProfileConfig, getProfileItem } from '../config/profile'
import { checkProfileConfig, hasCoreProcess } from '../core/manager'
import { generateProfile } from '../core/factory'
import {
  getAxios,
  mihomoCloseConnection,
  mihomoHotReloadConfig,
  mihomoProxies
} from '../core/mihomoApi'
import { getProxyEgressSelection, setProxyEgressSelection } from '../core/proxyEgressState'
import { mihomoWorkDir } from '../utils/dirs'
import { createLogger } from '../utils/logger'
import type { ProxyEgressSelection, ProxyEgressStatus } from '../../shared/proxyEgress'
import { getDefaultMihomoTunDevice } from '../../shared/appConfig'
import { ProxyEgressController } from './proxyEgressController'
import { proxyConnectionIds } from './proxyEgressPolicy'
import { readPhysicalInterfaces } from './physicalInterfaces'
import { prepareHotspotTun } from './hotspotTun'

const logger = createLogger('ProxyEgress')
let controllerPromise: Promise<ProxyEgressController> | undefined
let timer: NodeJS.Timeout | undefined
let stopped = false

function assertActive(signal: AbortSignal): void {
  if (signal.aborted || stopped) throw new Error('Proxy egress change cancelled')
}

export async function applyProxyEgressChange(
  next: ProxyEgressSelection | null,
  signal: AbortSignal
): Promise<void> {
  assertActive(signal)
  const previous = getProxyEgressSelection()
  if (!hasCoreProcess()) {
    setProxyEgressSelection(next)
    return
  }
  const candidate = path.join(mihomoWorkDir(), `.proxy-egress-${randomUUID()}.yaml`)
  let changed = false
  try {
    const appConfig = await getAppConfig()
    const { current } = await getProfileConfig()
    const ageSecretKey =
      appConfig.operationMode === 'simple'
        ? undefined
        : (await getProfileItem(current))?.ageSecretKey
    await mkdir(mihomoWorkDir(), { recursive: true })
    await generateProfile(undefined, {
      outputPath: candidate,
      updateRuntimeConfig: false,
      egressSelection: next
    })
    await checkProfileConfig(candidate, appConfig.core, ageSecretKey, { signal, timeoutMs: 15000 })
    assertActive(signal)
    if (!hasCoreProcess()) {
      setProxyEgressSelection(next)
      return
    }
    const api = await getAxios()
    const connections = await api.get<
      unknown,
      { connections?: { id: string; chains?: string[] }[] }
    >('/connections')
    const proxies = await mihomoProxies()
    const ids = proxyConnectionIds(connections.connections ?? [], proxies.proxies)
    assertActive(signal)
    setProxyEgressSelection(next)
    changed = true
    const { tun } = await getControledMihomoConfig()
    if (tun?.enable)
      await prepareHotspotTun(tun.device || getDefaultMihomoTunDevice(process.platform))
    assertActive(signal)
    await mihomoHotReloadConfig({ allowRestart: false })
    assertActive(signal)
    // A socket cannot migrate between adapters. Leave DIRECT connections alone.
    for (const id of ids) {
      assertActive(signal)
      try {
        await mihomoCloseConnection(id)
      } catch {
        logger.warn('Unable to close a previous proxy connection')
      }
    }
    logger.info('Proxy egress applied', {
      proxy: next?.proxy?.name ?? null,
      direct: next?.direct?.name ?? null
    })
  } catch (error) {
    if (changed) {
      setProxyEgressSelection(previous)
      if (hasCoreProcess() && !stopped) {
        try {
          await mihomoHotReloadConfig({ allowRestart: false })
        } catch {
          throw new Error(
            'Proxy egress apply and rollback failed; disable wireless priority and reload the profile'
          )
        }
      }
    }
    if (signal.aborted || stopped) throw error
    throw new Error('Unable to apply proxy egress; previous configuration retained')
  } finally {
    await rm(candidate, { force: true }).catch(() =>
      logger.warn('Unable to remove proxy egress candidate')
    )
  }
}

async function getController(): Promise<ProxyEgressController> {
  controllerPromise ??= (async () => {
    const { preferWirelessForProxy = false } = await getAppConfig()
    return new ProxyEgressController(
      {
        read: readPhysicalInterfaces,
        preferredDirect: async () => {
          const config = await getControledMihomoConfig()
          const value = (config as Record<string, unknown>)['interface-name']
          return typeof value === 'string' ? value : undefined
        },
        apply: applyProxyEgressChange,
        persist: async (enabled) => {
          await patchAppConfig({ preferWirelessForProxy: enabled })
        },
        now: () => performance.now()
      },
      process.platform === 'win32' && preferWirelessForProxy
    )
  })()
  return controllerPromise
}

function refreshTimer(controller: ProxyEgressController, pollNow = true): void {
  if (timer) clearInterval(timer)
  timer = undefined
  if (stopped || !controller.status().enabled) return
  if (pollNow) void controller.poll()
  timer = setInterval(() => {
    void controller.poll()
  }, 2000)
  timer.unref()
}

export async function initializeProxyEgress(beforeCoreStart = false): Promise<void> {
  if (process.platform !== 'win32' || stopped) return
  const controller = await getController()
  if (beforeCoreStart && controller.status().enabled) {
    await controller.poll()
    if (controller.hasWirelessCandidate()) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await controller.poll()
    }
  }
  refreshTimer(controller, !beforeCoreStart)
}

export async function setPreferWirelessForProxy(enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('Wireless priority must be boolean')
  if (process.platform !== 'win32')
    throw new Error('Wireless proxy priority is only supported on Windows')
  const controller = await getController()
  try {
    await controller.setEnabled(enabled)
  } finally {
    refreshTimer(controller)
  }
}

export async function getProxyEgressStatus(): Promise<ProxyEgressStatus> {
  return (await getController()).status()
}

export function stopProxyEgress(): void {
  stopped = true
  if (timer) clearInterval(timer)
  timer = undefined
  void controllerPromise?.then((controller) => controller.dispose())
}

import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { app, BrowserWindow } from 'electron'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  addProfileItem,
  changeCurrentProfile,
  getAppConfig,
  getControledMihomoConfig,
  getCurrentProfileItem,
  getProfileConfig,
  getProfile,
  getProfileItem,
  getOverride,
  getOverrideConfig,
  getOverrideItem,
  addOverrideItem,
  updateOverrideItem,
  removeOverrideItem,
  setOverride,
  patchAppConfig,
  patchControledMihomoConfig,
  removeProfileItem
} from '../config'
import { hasCoreProcess, restartCore, startCore, stopCore } from '../core/manager'
import { setControlDns } from '../core/dnsOverrideGuard'
import {
  getAxios,
  mihomoHotReloadConfig,
  mihomoChangeProxy,
  mihomoCloseConnection,
  mihomoCloseAllConnections,
  mihomoGroups,
  mihomoProxies,
  mihomoProxyDelay,
  mihomoVersion,
  mihomoRules,
  mihomoRuleProviders,
  mihomoProxyProviders,
  mihomoUpdateRuleProviders,
  mihomoUpdateProxyProviders,
  mihomoRulesDisable,
  SysProxyStatus,
  TunStatus
} from '../core/mihomoApi'
import { setOperationMode } from '../simple/mode'
import { triggerSysProxy } from '../sys/sysproxy'
import { coreLogPath } from '../utils/dirs'

type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const appPatchSchema = z
  .strictObject({
    autoSetDNS: z.boolean().optional(),
    controlSniff: z.boolean().optional(),
    useNameserverPolicy: z.boolean().optional(),
    nameserverPolicy: z.unknown().optional()
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Patch must not be empty')

function isNameserverPolicy(value: unknown): value is IAppConfig['nameserverPolicy'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(
    ([key, server]) =>
      !['__proto__', 'constructor', 'prototype'].includes(key) &&
      (typeof server === 'string' ||
        (Array.isArray(server) && server.every((item) => typeof item === 'string')))
  )
}

function redactAppConfig(config: IAppConfig): Record<string, unknown> {
  const result: Record<string, unknown> = { ...config }
  for (const key of [
    'githubToken',
    'gistAgeSecretKey',
    'webdavPassword',
    'webdavUrl',
    'encryptedPassword',
    'mcpToken'
  ]) {
    if (result[key]) result[key] = '[REDACTED]'
  }
  return result
}

function redactMihomoConfig(config: Partial<IMihomoConfig>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...config }
  for (const key of ['secret', 'authentication']) {
    if (result[key]) result[key] = '[REDACTED]'
  }
  return result
}

function publicOverride(item: IOverrideItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    ext: item.ext,
    global: item.global ?? false,
    updated: item.updated
  }
}

function notifyRenderer(...events: string[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    for (const event of events) window.webContents.send(event)
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'app_get_status',
    {
      description:
        'Get Clash Party runtime status: app/core version, core running state, system proxy, TUN, kernel mode, operation mode and current profile.',
      inputSchema: {}
    },
    async () => {
      try {
        const [appConfig, mihomoConfig, coreRunning, sysProxy, tun, profile] = await Promise.all([
          getAppConfig(),
          getControledMihomoConfig(),
          Promise.resolve(hasCoreProcess()),
          SysProxyStatus(),
          TunStatus(),
          getCurrentProfileItem()
        ])
        let coreVersion: string | null = null
        if (coreRunning) {
          try {
            coreVersion = (await mihomoVersion()).version
          } catch {
            coreVersion = null
          }
        }
        return jsonResult({
          appVersion: app.getVersion(),
          coreVersion,
          coreRunning,
          systemProxyEnabled: sysProxy,
          tunEnabled: tun,
          kernelMode: mihomoConfig.mode ?? 'rule',
          operationMode: appConfig.operationMode ?? 'standard',
          currentProfile: profile ? { id: profile.id, name: profile.name } : null
        })
      } catch (e) {
        return errorResult(`Failed to read status: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_get_config',
    {
      description: 'Get the Clash Party application config with credentials redacted.',
      inputSchema: {}
    },
    async () => {
      try {
        return jsonResult(redactAppConfig(await getAppConfig()))
      } catch (e) {
        return errorResult(`Failed to read app config: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_get_mihomo_config',
    {
      description:
        'Get the controlled mihomo kernel config: ports, mode, TUN, DNS, sniffer, etc. Credentials are redacted.',
      inputSchema: {}
    },
    async () => {
      try {
        return jsonResult(redactMihomoConfig(await getControledMihomoConfig()))
      } catch (e) {
        return errorResult(`Failed to read mihomo config: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_get_profiles',
    {
      description: 'List subscription profiles and mark the current one.',
      inputSchema: {}
    },
    async () => {
      try {
        const [config, current] = await Promise.all([getProfileConfig(), getCurrentProfileItem()])
        return jsonResult({
          current: current?.id ?? null,
          profiles: (config.items ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            updated: item.updated ?? null
          }))
        })
      } catch (e) {
        return errorResult(`Failed to list profiles: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'profile_import',
    {
      description:
        'Import and validate a remote subscription without changing the current profile. The URL may contain credentials and is never returned.',
      inputSchema: {
        url: z.string().min(1).describe('Remote subscription URL (may contain a private token)'),
        name: z.string().trim().min(1).max(100).optional(),
        useProxy: z
          .boolean()
          .optional()
          .describe('Fetch the subscription through the current proxy')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ url, name, useProxy }) => {
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return errorResult('Subscription URL must use HTTP or HTTPS')
        }
        const id = randomUUID()
        await addProfileItem({ id, name, type: 'remote', url, useProxy })
        notifyRenderer('profileConfigUpdated')
        const item = await getProfileItem(id)
        return jsonResult({ ok: true, id, name: item?.name ?? name ?? 'Remote File' })
      } catch {
        return errorResult('Failed to import subscription; check the app log for details')
      }
    }
  )

  server.registerTool(
    'profile_get_nodes',
    {
      description:
        'List node names and types in a saved subscription without exposing server credentials.',
      inputSchema: { id: z.string().describe('Profile id (see app_get_profiles)') }
    },
    async ({ id }) => {
      try {
        const item = await getProfileItem(id)
        if (!item) return errorResult('Profile not found')
        const profile = await getProfile(id)
        const nodes = ((profile.proxies ?? []) as { name: string; type: string }[]).map((node) => ({
          name: node.name,
          type: node.type
        }))
        return jsonResult({ id, name: item.name, nodes })
      } catch {
        return errorResult('Failed to read subscription nodes')
      }
    }
  )

  server.registerTool(
    'profile_refresh',
    {
      description:
        'Re-download and validate an existing remote subscription without switching profiles.',
      inputSchema: { id: z.string().describe('Remote profile id (see app_get_profiles)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ id }) => {
      try {
        const item = await getProfileItem(id)
        if (item?.type !== 'remote') return errorResult('Remote profile not found')
        await addProfileItem(item)
        notifyRenderer('profileConfigUpdated')
        return jsonResult({ ok: true, id })
      } catch {
        return errorResult('Failed to refresh subscription; check the app log for details')
      }
    }
  )

  server.registerTool(
    'profile_remove',
    {
      description: 'Remove a saved remote subscription. Refuses to remove the current profile.',
      inputSchema: { id: z.string().describe('Remote profile id (see app_get_profiles)') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ id }) => {
      try {
        const config = await getProfileConfig()
        if (config.current === id) return errorResult('Cannot remove the current profile')
        const item = await getProfileItem(id)
        if (item?.type !== 'remote') return errorResult('Remote profile not found')
        await removeProfileItem(id)
        notifyRenderer('profileConfigUpdated')
        return jsonResult({ ok: true, id })
      } catch {
        return errorResult('Failed to remove subscription; check the app log for details')
      }
    }
  )

  server.registerTool(
    'overrides_get',
    {
      description:
        'List saved overrides in order without returning remote URLs or script contents.',
      inputSchema: {}
    },
    async () => {
      try {
        const { items } = await getOverrideConfig()
        return jsonResult({ overrides: items.map(publicOverride) })
      } catch (e) {
        return errorResult(`Failed to list overrides: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'override_get_content',
    {
      description:
        'Read the content of a saved local JS or YAML override. Content may include private data.',
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        const item = await getOverrideItem(id)
        if (!item || item.type !== 'local') return errorResult('Local override not found')
        return jsonResult({ ...publicOverride(item), content: await getOverride(id, item.ext) })
      } catch (e) {
        return errorResult(`Failed to read override: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'override_add_local',
    {
      description:
        'Create a local JS or YAML override; does not enable it for a subscription automatically.',
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        ext: z.enum(['js', 'yaml']),
        content: z.string(),
        global: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ name, ext, content, global }) => {
      try {
        const id = randomUUID()
        await addOverrideItem({ id, name, type: 'local', ext, file: content, global })
        notifyRenderer('overrideConfigUpdated')
        return jsonResult({ ok: true, id, name, ext })
      } catch (e) {
        return errorResult(`Failed to add override: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'override_set_content',
    {
      description: 'Replace the content of a saved local override and reload the running core.',
      inputSchema: { id: z.string().min(1), content: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ id, content }) => {
      try {
        const item = await getOverrideItem(id)
        if (!item || item.type !== 'local') return errorResult('Local override not found')
        await setOverride(id, item.ext, content)
        if (hasCoreProcess()) await mihomoHotReloadConfig()
        notifyRenderer('overrideConfigUpdated')
        return jsonResult({ ok: true, id })
      } catch (e) {
        return errorResult(`Failed to save override: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'override_update_metadata',
    {
      description: 'Rename an override or change whether it applies globally.',
      inputSchema: {
        id: z.string().min(1),
        name: z.string().trim().min(1).max(100).optional(),
        global: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ id, name, global }) => {
      try {
        if (name === undefined && global === undefined) return errorResult('No changes supplied')
        const item = await getOverrideItem(id)
        if (!item) return errorResult('Override not found')
        await updateOverrideItem({
          ...item,
          name: name ?? item.name,
          global: global ?? item.global
        })
        if (hasCoreProcess()) await mihomoHotReloadConfig()
        notifyRenderer('overrideConfigUpdated')
        return jsonResult({ ok: true, id })
      } catch (e) {
        return errorResult(`Failed to update override: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'override_remove',
    {
      description: 'Permanently delete a saved override and its local file.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      try {
        if (!(await getOverrideItem(id))) return errorResult('Override not found')
        await removeOverrideItem(id)
        if (hasCoreProcess()) await mihomoHotReloadConfig()
        notifyRenderer('overrideConfigUpdated')
        return jsonResult({ ok: true, id })
      } catch (e) {
        return errorResult(`Failed to remove override: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_get_connections',
    {
      description: 'List active connections from the mihomo kernel, sorted by download speed.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max connections to return, default 50')
      }
    },
    async ({ limit }) => {
      try {
        const instance = await getAxios()
        const data = (await instance.get('/connections')) as unknown as IMihomoConnectionsInfo
        const connections = (data.connections ?? [])
          .slice()
          .sort((a, b) => (b.downloadSpeed ?? 0) - (a.downloadSpeed ?? 0))
          .slice(0, limit ?? 50)
          .map((c) => ({
            id: c.id,
            host: c.metadata.host || c.metadata.destinationIP,
            destinationIP: c.metadata.destinationIP,
            destinationPort: c.metadata.destinationPort,
            network: c.metadata.network,
            process: c.metadata.process,
            rule: c.rule,
            chains: c.chains,
            start: c.start,
            upload: c.upload,
            download: c.download,
            uploadSpeed: c.uploadSpeed ?? 0,
            downloadSpeed: c.downloadSpeed ?? 0
          }))
        return jsonResult({
          total: data.connections?.length ?? 0,
          downloadTotal: data.downloadTotal,
          uploadTotal: data.uploadTotal,
          memory: data.memory,
          connections
        })
      } catch (e) {
        return errorResult(`Failed to read connections (is the core running?): ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'connection_close',
    {
      description: 'Close one active connection by its id from app_get_connections.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      try {
        await mihomoCloseConnection(id)
        return jsonResult({ ok: true, id })
      } catch (e) {
        return errorResult(`Failed to close connection: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'connections_close_all',
    {
      description: 'Close all active connections. Existing application traffic may reconnect.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async () => {
      try {
        await mihomoCloseAllConnections()
        return jsonResult({ ok: true })
      } catch (e) {
        return errorResult(`Failed to close connections: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'rules_get',
    {
      description: 'Inspect effective mihomo rules in evaluation order, with a bounded result.',
      inputSchema: {
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async ({ offset = 0, limit = 100 }) => {
      try {
        const { rules } = await mihomoRules()
        return jsonResult({
          total: rules.length,
          offset,
          rules: rules.slice(offset, offset + limit)
        })
      } catch (e) {
        return errorResult(`Failed to read rules: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'rules_set_disabled',
    {
      description: 'Enable or disable one effective rule by its index from rules_get.',
      inputSchema: { index: z.number().int().min(0), disabled: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ index, disabled }) => {
      try {
        const { rules } = await mihomoRules()
        if (!rules.some((rule) => rule.index === index)) return errorResult('Rule not found')
        await mihomoRulesDisable({ [index]: disabled })
        return jsonResult({ ok: true, index, disabled })
      } catch (e) {
        return errorResult(`Failed to change rule: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'rule_providers_get',
    {
      description: 'List loaded rule providers and their status, omitting rule payloads.',
      inputSchema: {}
    },
    async () => {
      try {
        const { providers } = await mihomoRuleProviders()
        return jsonResult({
          providers: Object.values(providers).map((provider) => ({
            name: provider.name,
            type: provider.type,
            behavior: provider.behavior,
            format: provider.format,
            ruleCount: provider.ruleCount,
            updatedAt: provider.updatedAt,
            vehicleType: provider.vehicleType
          }))
        })
      } catch (e) {
        return errorResult(`Failed to read rule providers: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'proxy_providers_get',
    {
      description: 'List loaded proxy providers and node counts, omitting node credentials.',
      inputSchema: {}
    },
    async () => {
      try {
        const { providers } = await mihomoProxyProviders()
        return jsonResult({
          providers: Object.values(providers).map((provider) => ({
            name: provider.name,
            type: provider.type,
            nodeCount: provider.proxies?.length ?? 0,
            updatedAt: provider.updatedAt,
            vehicleType: provider.vehicleType,
            expectedStatus: provider.expectedStatus
          }))
        })
      } catch (e) {
        return errorResult(`Failed to read proxy providers: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'provider_refresh',
    {
      description: 'Refresh one loaded rule or proxy provider using the app core API.',
      inputSchema: { kind: z.enum(['rule', 'proxy']), name: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ kind, name }) => {
      try {
        const providers =
          kind === 'rule'
            ? (await mihomoRuleProviders()).providers
            : (await mihomoProxyProviders()).providers
        if (!Object.hasOwn(providers, name)) return errorResult('Provider not found')
        if (kind === 'rule') await mihomoUpdateRuleProviders(name)
        else await mihomoUpdateProxyProviders(name)
        return jsonResult({ ok: true, kind, name })
      } catch (e) {
        return errorResult(`Failed to refresh provider: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_get_proxies',
    {
      description:
        'List proxy groups with their current selection. Pass a group name to include its member names.',
      inputSchema: {
        group: z.string().optional().describe('Group name to inspect members of')
      }
    },
    async ({ group }) => {
      try {
        const groups = await mihomoGroups()
        return jsonResult({
          groups: groups.map((g) => ({
            name: g.name,
            type: g.type,
            now: g.now,
            memberCount: g.all.length,
            members: group && g.name === group ? g.all.map((m) => m.name) : undefined
          }))
        })
      } catch (e) {
        return errorResult(`Failed to read proxies (is the core running?): ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'proxy_delay_test',
    {
      description:
        'Test one node loaded in the running core. Does not change proxy selection; switch profiles explicitly before testing an imported subscription.',
      inputSchema: { name: z.string().describe('Node name in the current profile') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ name }) => {
      try {
        if (!hasCoreProcess()) return errorResult('Core is not running')
        const proxy = (await mihomoProxies()).proxies[name]
        if (!proxy || 'all' in proxy) return errorResult('Node not found in the running core')
        const result = await mihomoProxyDelay(name)
        return jsonResult({
          name,
          reachable: Boolean(result.delay && result.delay > 0),
          delayMs: result.delay ?? null
        })
      } catch {
        return jsonResult({ name, reachable: false, delayMs: null })
      }
    }
  )

  server.registerTool(
    'app_get_logs',
    {
      description: 'Read the tail of the mihomo core log file.',
      inputSchema: {
        lines: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Number of lines from the end, default 100')
      }
    },
    async ({ lines }) => {
      try {
        const count = lines ?? 100
        const content = await readFile(coreLogPath(), 'utf-8')
        const all = content.split(/\r?\n/)
        return jsonResult({ path: coreLogPath(), lines: all.slice(-count - 1) })
      } catch (e) {
        return errorResult(`Failed to read core log: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_patch_config',
    {
      description:
        'Update supported DNS and sniffer app settings. Use dedicated tools for operation mode, DNS override and system proxy. Returns the config with credentials redacted.',
      inputSchema: { patch: appPatchSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ patch }) => {
      try {
        if (
          (await getAppConfig()).operationMode === 'simple' &&
          ('controlSniff' in patch || 'useNameserverPolicy' in patch || 'nameserverPolicy' in patch)
        ) {
          return errorResult('DNS policy and sniffer app settings require standard mode')
        }
        if (patch.nameserverPolicy !== undefined && !isNameserverPolicy(patch.nameserverPolicy)) {
          return errorResult('Invalid DNS policy or unsafe key')
        }
        await patchAppConfig(patch as Partial<IAppConfig>)
        try {
          if (patch.nameserverPolicy !== undefined) {
            await patchControledMihomoConfig({
              dns: { 'nameserver-policy': patch.nameserverPolicy }
            })
          }
          if (hasCoreProcess() && ('controlSniff' in patch || 'useNameserverPolicy' in patch)) {
            await mihomoHotReloadConfig()
          }
        } finally {
          notifyRenderer('appConfigUpdated', 'controledMihomoConfigUpdated')
        }
        return jsonResult(redactAppConfig(await getAppConfig()))
      } catch (e) {
        return errorResult(`Failed to patch app config: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_patch_mihomo_config',
    {
      description:
        'Patch the controlled mihomo kernel config (mihomo.yaml), e.g. {tun:{enable:true}} or DNS settings. The app writes the config, regenerates the runtime profile and hot-patches the running core.',
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe('Partial IMihomoConfig fields to patch')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ patch }) => {
      try {
        await patchControledMihomoConfig(patch as Partial<IMihomoConfig>)
        notifyRenderer('controledMihomoConfigUpdated')
        return jsonResult(redactMihomoConfig(await getControledMihomoConfig()))
      } catch (e) {
        return errorResult(`Failed to patch mihomo config: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'operation_mode_set',
    {
      description: 'Switch configuration modes using the app migration and rollback flow.',
      inputSchema: { mode: z.enum(['standard', 'simple']) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ mode }) => {
      try {
        await setOperationMode(mode)
        notifyRenderer('appConfigUpdated')
        return jsonResult({ ok: true, operationMode: mode })
      } catch (e) {
        return errorResult(`Failed to switch operation mode: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'dns_override_set',
    {
      description:
        'Enable or disable DNS override. If confirmation is required, repeat with the returned confirmation value.',
      inputSchema: { enable: z.boolean(), confirmation: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ enable, confirmation }) => {
      try {
        return jsonResult(await setControlDns(enable, confirmation))
      } catch (e) {
        return errorResult(`Failed to set DNS override: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'core_control',
    {
      description: 'Start, stop or restart the mihomo core process.',
      inputSchema: {
        action: z.enum(['start', 'stop', 'restart']).describe('Action to perform')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ action }) => {
      try {
        if (action === 'start') {
          const promises = await startCore()
          if (promises.length > 0) await promises[0]
        } else if (action === 'stop') {
          await stopCore()
        } else {
          await restartCore()
        }
        return jsonResult({ ok: true, action, coreRunning: hasCoreProcess() })
      } catch (e) {
        return errorResult(`Failed to ${action} core: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'profile_switch',
    {
      description: 'Switch the current subscription profile by id.',
      inputSchema: {
        id: z.string().describe('Profile id (see app_get_profiles)')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ id }) => {
      try {
        const item = await getProfileItem(id)
        if (!item) return errorResult(`Profile not found: ${id}`)
        await changeCurrentProfile(id)
        notifyRenderer('profileConfigUpdated')
        return jsonResult({ ok: true, current: id, name: item.name })
      } catch (e) {
        return errorResult(`Failed to switch profile: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'proxy_select',
    {
      description: 'Select a proxy node inside a proxy group.',
      inputSchema: {
        group: z.string().describe('Proxy group name'),
        proxy: z.string().describe('Proxy node name to select')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ group, proxy }) => {
      try {
        const result = await mihomoChangeProxy(group, proxy)
        return jsonResult({ ok: true, group, proxy, result })
      } catch (e) {
        return errorResult(`Failed to select proxy: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'sysproxy_set',
    {
      description: 'Enable or disable the system proxy (same flow as the app UI toggle).',
      inputSchema: {
        enable: z.boolean().describe('true to enable, false to disable')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ enable }) => {
      try {
        const previous = (await getAppConfig()).sysProxy.enable
        await patchAppConfig({ sysProxy: { enable } })
        try {
          await triggerSysProxy(enable)
        } catch (e) {
          await patchAppConfig({ sysProxy: { enable: previous } })
          throw e
        } finally {
          notifyRenderer('appConfigUpdated')
        }
        return jsonResult({ ok: true, systemProxyEnabled: enable })
      } catch (e) {
        return errorResult(`Failed to toggle system proxy: ${errorMessage(e)}`)
      }
    }
  )
}

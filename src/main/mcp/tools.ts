import { readFile } from 'fs/promises'
import { app } from 'electron'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  changeCurrentProfile,
  getAppConfig,
  getControledMihomoConfig,
  getCurrentProfileItem,
  getProfileConfig,
  getProfileItem,
  patchAppConfig,
  patchControledMihomoConfig
} from '../config'
import { hasCoreProcess, restartCore, startCore, stopCore } from '../core/manager'
import {
  getAxios,
  mihomoChangeProxy,
  mihomoGroups,
  mihomoVersion,
  SysProxyStatus,
  TunStatus
} from '../core/mihomoApi'
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
      description: 'Get the full Clash Party application config (config.yaml).',
      inputSchema: {}
    },
    async () => {
      try {
        return jsonResult(await getAppConfig())
      } catch (e) {
        return errorResult(`Failed to read app config: ${errorMessage(e)}`)
      }
    }
  )

  server.registerTool(
    'app_get_mihomo_config',
    {
      description:
        'Get the controlled mihomo kernel config (mihomo.yaml): ports, mode, TUN, DNS, sniffer, etc.',
      inputSchema: {}
    },
    async () => {
      try {
        return jsonResult(await getControledMihomoConfig())
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
        'Patch the Clash Party application config (config.yaml). Values are deep-merged; returns the updated config.',
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe('Partial IAppConfig fields to patch')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ patch }) => {
      try {
        await patchAppConfig(patch as Partial<IAppConfig>)
        return jsonResult(await getAppConfig())
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
        return jsonResult(await getControledMihomoConfig())
      } catch (e) {
        return errorResult(`Failed to patch mihomo config: ${errorMessage(e)}`)
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
        await patchAppConfig({ sysProxy: { enable } })
        try {
          await triggerSysProxy(enable)
        } catch (e) {
          await patchAppConfig({ sysProxy: { enable: !enable } })
          throw e
        }
        return jsonResult({ ok: true, systemProxyEnabled: enable })
      } catch (e) {
        return errorResult(`Failed to toggle system proxy: ${errorMessage(e)}`)
      }
    }
  )
}

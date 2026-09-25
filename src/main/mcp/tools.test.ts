import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { registerTools } from './tools'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getAppConfig: vi.fn(),
  patchAppConfig: vi.fn(),
  getControledMihomoConfig: vi.fn(),
  patchControledMihomoConfig: vi.fn(),
  getProfileItem: vi.fn(),
  getProfileConfig: vi.fn(),
  getProfile: vi.fn(),
  addProfileItem: vi.fn(),
  removeProfileItem: vi.fn(),
  changeCurrentProfile: vi.fn(),
  mihomoProxies: vi.fn(),
  mihomoProxyDelay: vi.fn(),
  hasCoreProcess: vi.fn(),
  mihomoHotReloadConfig: vi.fn(),
  setOperationMode: vi.fn(),
  setControlDns: vi.fn(),
  triggerSysProxy: vi.fn(),
  getOverrideConfig: vi.fn(),
  getOverrideItem: vi.fn(),
  getOverride: vi.fn(),
  addOverrideItem: vi.fn(),
  updateOverrideItem: vi.fn(),
  removeOverrideItem: vi.fn(),
  setOverride: vi.fn(),
  mihomoRules: vi.fn(),
  mihomoRulesDisable: vi.fn(),
  mihomoRuleProviders: vi.fn(),
  mihomoProxyProviders: vi.fn(),
  mihomoUpdateRuleProviders: vi.fn(),
  mihomoUpdateProxyProviders: vi.fn(),
  mihomoCloseConnection: vi.fn(),
  mihomoCloseAllConnections: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '2.0.3' },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] }
}))
vi.mock('../config', () => ({
  getAppConfig: mocks.getAppConfig,
  patchAppConfig: mocks.patchAppConfig,
  getControledMihomoConfig: mocks.getControledMihomoConfig,
  patchControledMihomoConfig: mocks.patchControledMihomoConfig,
  getProfileItem: mocks.getProfileItem,
  getProfileConfig: mocks.getProfileConfig,
  getProfile: mocks.getProfile,
  addProfileItem: mocks.addProfileItem,
  removeProfileItem: mocks.removeProfileItem,
  changeCurrentProfile: mocks.changeCurrentProfile,
  getOverrideConfig: mocks.getOverrideConfig,
  getOverrideItem: mocks.getOverrideItem,
  getOverride: mocks.getOverride,
  addOverrideItem: mocks.addOverrideItem,
  updateOverrideItem: mocks.updateOverrideItem,
  removeOverrideItem: mocks.removeOverrideItem,
  setOverride: mocks.setOverride
}))
vi.mock('../core/manager', () => ({ hasCoreProcess: mocks.hasCoreProcess }))
vi.mock('../core/mihomoApi', () => ({
  mihomoHotReloadConfig: mocks.mihomoHotReloadConfig,
  mihomoProxies: mocks.mihomoProxies,
  mihomoProxyDelay: mocks.mihomoProxyDelay,
  mihomoRules: mocks.mihomoRules,
  mihomoRulesDisable: mocks.mihomoRulesDisable,
  mihomoRuleProviders: mocks.mihomoRuleProviders,
  mihomoProxyProviders: mocks.mihomoProxyProviders,
  mihomoUpdateRuleProviders: mocks.mihomoUpdateRuleProviders,
  mihomoUpdateProxyProviders: mocks.mihomoUpdateProxyProviders,
  mihomoCloseConnection: mocks.mihomoCloseConnection,
  mihomoCloseAllConnections: mocks.mihomoCloseAllConnections
}))
vi.mock('../core/dnsOverrideGuard', () => ({ setControlDns: mocks.setControlDns }))
vi.mock('../simple/mode', () => ({ setOperationMode: mocks.setOperationMode }))
vi.mock('../sys/sysproxy', () => ({ triggerSysProxy: mocks.triggerSysProxy }))
vi.mock('../utils/dirs', () => ({ coreLogPath: () => 'core.log' }))

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
type RegisteredTool = {
  schema: Record<string, z.ZodType>
  run: (args: Record<string, unknown>) => Promise<Result>
}

const tools = new Map<string, RegisteredTool>()
const server = {
  registerTool: (
    name: string,
    options: { inputSchema: RegisteredTool['schema'] },
    run: RegisteredTool['run']
  ) => {
    tools.set(name, { schema: options.inputSchema, run })
  }
} as unknown as McpServer

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return tool.run(args)
}

let appConfig: Record<string, unknown>
let mihomoConfig: Record<string, unknown>

beforeEach(() => {
  vi.resetAllMocks()
  appConfig = {
    operationMode: 'standard',
    sysProxy: { enable: false },
    autoSetDNS: true,
    githubToken: 'github-secret',
    gistAgeSecretKey: 'age-secret',
    webdavPassword: 'webdav-secret',
    webdavUrl: 'https://private.example/backup',
    encryptedPassword: [1, 2],
    mcpToken: 'mcp-secret'
  }
  mihomoConfig = { mode: 'rule', secret: 'core-secret', authentication: ['user:pass'] }
  mocks.getAppConfig.mockImplementation(async () => appConfig)
  mocks.patchAppConfig.mockImplementation(async (patch: Record<string, unknown>) => {
    Object.assign(appConfig, patch)
  })
  mocks.getControledMihomoConfig.mockImplementation(async () => mihomoConfig)
  mocks.patchControledMihomoConfig.mockResolvedValue(undefined)
  mocks.hasCoreProcess.mockReturnValue(true)
  mocks.mihomoHotReloadConfig.mockResolvedValue(undefined)
  mocks.getProfileItem.mockResolvedValue({ id: 'p1', name: 'Profile 1', type: 'remote' })
  mocks.getProfileConfig.mockResolvedValue({ current: 'p1', items: [] })
  mocks.getProfile.mockResolvedValue({
    proxies: [{ name: 'Node 1', type: 'ss', password: 'secret' }]
  })
  mocks.addProfileItem.mockResolvedValue(undefined)
  mocks.removeProfileItem.mockResolvedValue(undefined)
  mocks.mihomoProxies.mockResolvedValue({ proxies: { 'Node 1': { name: 'Node 1', type: 'ss' } } })
  mocks.mihomoProxyDelay.mockResolvedValue({ delay: 213 })
  mocks.changeCurrentProfile.mockResolvedValue(undefined)
  mocks.setOperationMode.mockResolvedValue(undefined)
  mocks.setControlDns.mockResolvedValue({ status: 'applied' })
  mocks.triggerSysProxy.mockResolvedValue(undefined)
  mocks.getOverrideConfig.mockResolvedValue({
    items: [
      {
        id: 'o1',
        name: 'Test',
        type: 'local',
        ext: 'js',
        url: 'https://private.example/?token=secret'
      }
    ]
  })
  mocks.getOverrideItem.mockResolvedValue({ id: 'o1', name: 'Test', type: 'local', ext: 'js' })
  mocks.getOverride.mockResolvedValue('function main() {}')
  mocks.mihomoRules.mockResolvedValue({
    rules: [
      { index: 0, type: 'DOMAIN', payload: 'example.org', proxy: 'DIRECT' },
      { index: 1, type: 'MATCH', payload: '', proxy: 'Proxy' }
    ]
  })
  mocks.mihomoRuleProviders.mockResolvedValue({
    providers: { test: { name: 'test', ruleCount: 1, payload: ['secret'], type: 'http' } }
  })
  mocks.mihomoProxyProviders.mockResolvedValue({
    providers: {
      test: { name: 'test', proxies: [{ name: 'node', password: 'secret' }], type: 'http' }
    }
  })
  tools.clear()
  registerTools(server)
})

describe('MCP configuration tools', () => {
  it('redacts credentials from app and core reads without changing in-memory config', async () => {
    const appResult = JSON.parse((await call('app_get_config')).content[0].text)
    const coreResult = JSON.parse((await call('app_get_mihomo_config')).content[0].text)
    for (const key of [
      'githubToken',
      'gistAgeSecretKey',
      'webdavPassword',
      'webdavUrl',
      'encryptedPassword',
      'mcpToken'
    ]) {
      expect(appResult[key]).toBe('[REDACTED]')
    }
    expect(coreResult.secret).toBe('[REDACTED]')
    expect(coreResult.authentication).toBe('[REDACTED]')
    expect(appConfig.githubToken).toBe('github-secret')
    expect(mihomoConfig.secret).toBe('core-secret')
  })

  it('rejects unrelated config fields and exposes a valid MCP JSON Schema', () => {
    const schema = tools.get('app_patch_config')?.schema.patch
    if (!schema) throw new Error('Missing app patch schema')
    expect(schema.safeParse({ operationMode: 'simple' }).success).toBe(false)
    expect(schema.safeParse({ sysProxy: { enable: true } }).success).toBe(false)
    expect(schema.safeParse({ mcpToken: 'other' }).success).toBe(false)
    expect(schema.safeParse({ autoSetDNS: false }).success).toBe(true)
    expect(() => z.toJSONSchema(z.object({ patch: schema }))).not.toThrow()
  })

  it('lists tools and rejects protected fields over the MCP protocol', async () => {
    const realServer = new McpServer({ name: 'clash-party-test', version: '1.0.0' })
    registerTools(realServer)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await realServer.connect(serverTransport)
      await client.connect(clientTransport)
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toContain('app_patch_config')
      for (const name of [
        'profile_import',
        'profile_get_nodes',
        'profile_refresh',
        'profile_remove',
        'proxy_delay_test'
      ]) {
        expect(listed.tools.map((tool) => tool.name)).toContain(name)
      }
      const result = await client.callTool({
        name: 'app_patch_config',
        arguments: { patch: { operationMode: 'simple' } }
      })
      expect(result.isError).toBe(true)
      expect(mocks.patchAppConfig).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await realServer.close()
    }
  })

  it('rejects unsafe policy keys before writing config', async () => {
    const result = await call('app_patch_config', {
      patch: { nameserverPolicy: JSON.parse('{"__proto__":"x"}') }
    })
    expect(result.isError).toBe(true)
    expect(mocks.patchAppConfig).not.toHaveBeenCalled()
  })

  it('applies supported config through the core flow, notifies the UI and redacts the reply', async () => {
    const policy = { '+.example.org': '1.1.1.1' }
    const result = await call('app_patch_config', {
      patch: { useNameserverPolicy: true, nameserverPolicy: policy }
    })
    expect(mocks.patchAppConfig).toHaveBeenCalledWith({
      useNameserverPolicy: true,
      nameserverPolicy: policy
    })
    expect(mocks.patchControledMihomoConfig).toHaveBeenCalledWith({
      dns: { 'nameserver-policy': policy }
    })
    expect(mocks.mihomoHotReloadConfig).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith('appConfigUpdated')
    expect(mocks.send).toHaveBeenCalledWith('controledMihomoConfigUpdated')
    expect(JSON.parse(result.content[0].text).mcpToken).toBe('[REDACTED]')
  })

  it('uses dedicated mode and DNS override flows', async () => {
    await call('operation_mode_set', { mode: 'simple' })
    await call('dns_override_set', { enable: true, confirmation: 'fingerprint' })
    expect(mocks.setOperationMode).toHaveBeenCalledWith('simple')
    expect(mocks.setControlDns).toHaveBeenCalledWith(true, 'fingerprint')
    expect(mocks.send).toHaveBeenCalledWith('appConfigUpdated')
  })

  it('notifies open windows after a core patch and profile switch', async () => {
    const result = await call('app_patch_mihomo_config', { patch: { mode: 'global' } })
    await call('profile_switch', { id: 'p1' })
    expect(JSON.parse(result.content[0].text).secret).toBe('[REDACTED]')
    expect(mocks.send).toHaveBeenCalledWith('controledMihomoConfigUpdated')
    expect(mocks.send).toHaveBeenCalledWith('profileConfigUpdated')
  })

  it('imports without switching and never returns a private subscription URL', async () => {
    const url = 'https://example.org/sub?token=private-value'
    const result = await call('profile_import', { url, name: 'Temporary' })
    const value = JSON.parse(result.content[0].text)
    expect(value.ok).toBe(true)
    expect(value.id).toBeTruthy()
    expect(result.content[0].text).not.toContain('private-value')
    expect(mocks.addProfileItem).toHaveBeenCalledWith({
      id: value.id,
      name: 'Temporary',
      type: 'remote',
      url,
      useProxy: undefined
    })
    expect(mocks.changeCurrentProfile).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith('profileConfigUpdated')
  })

  it('does not leak the URL when import fails', async () => {
    mocks.addProfileItem.mockRejectedValueOnce(new Error('bad URL: token=private-value'))
    const result = await call('profile_import', {
      url: 'https://example.org/sub?token=private-value'
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain('private-value')
  })

  it('reads only node names and types, and refreshes the existing remote profile', async () => {
    const nodes = JSON.parse((await call('profile_get_nodes', { id: 'p1' })).content[0].text)
    expect(nodes.nodes).toEqual([{ name: 'Node 1', type: 'ss' }])
    expect(JSON.stringify(nodes)).not.toContain('secret')
    const result = await call('profile_refresh', { id: 'p1' })
    expect(result.isError).toBeUndefined()
    expect(mocks.addProfileItem).toHaveBeenCalledWith({
      id: 'p1',
      name: 'Profile 1',
      type: 'remote'
    })
  })

  it('refuses to remove the current profile and removes an inactive remote profile', async () => {
    const current = await call('profile_remove', { id: 'p1' })
    expect(current.isError).toBe(true)
    expect(mocks.removeProfileItem).not.toHaveBeenCalled()
    mocks.getProfileConfig.mockResolvedValueOnce({ current: 'other', items: [] })
    const result = await call('profile_remove', { id: 'p1' })
    expect(result.isError).toBeUndefined()
    expect(mocks.removeProfileItem).toHaveBeenCalledWith('p1')
  })

  it('tests only a loaded leaf node without changing its selection', async () => {
    const result = JSON.parse((await call('proxy_delay_test', { name: 'Node 1' })).content[0].text)
    expect(result).toEqual({ name: 'Node 1', reachable: true, delayMs: 213 })
    expect(mocks.mihomoProxyDelay).toHaveBeenCalledWith('Node 1')
    expect(mocks.changeCurrentProfile).not.toHaveBeenCalled()
    mocks.mihomoProxies.mockResolvedValueOnce({ proxies: {} })
    expect((await call('proxy_delay_test', { name: 'missing' })).isError).toBe(true)
  })

  it('inspects rules and providers without leaking provider payloads or node credentials', async () => {
    const rules = JSON.parse((await call('rules_get', { offset: 1, limit: 1 })).content[0].text)
    expect(rules).toMatchObject({ total: 2, offset: 1, rules: [{ index: 1 }] })
    const ruleProviders = (await call('rule_providers_get')).content[0].text
    const proxyProviders = (await call('proxy_providers_get')).content[0].text
    expect(ruleProviders).not.toContain('secret')
    expect(proxyProviders).not.toContain('secret')
    expect(JSON.parse(proxyProviders).providers[0].nodeCount).toBe(1)
    await call('rules_set_disabled', { index: 1, disabled: true })
    expect(mocks.mihomoRulesDisable).toHaveBeenCalledWith({ 1: true })
    expect((await call('rules_set_disabled', { index: 9, disabled: true })).isError).toBe(true)
  })

  it('only refreshes loaded providers and closes connections through the app API', async () => {
    await call('provider_refresh', { kind: 'rule', name: 'test' })
    expect(mocks.mihomoUpdateRuleProviders).toHaveBeenCalledWith('test')
    expect((await call('provider_refresh', { kind: 'proxy', name: 'missing' })).isError).toBe(true)
    await call('connection_close', { id: 'connection-1' })
    await call('connections_close_all')
    expect(mocks.mihomoCloseConnection).toHaveBeenCalledWith('connection-1')
    expect(mocks.mihomoCloseAllConnections).toHaveBeenCalledOnce()
  })

  it('manages local overrides without exposing remote URLs or editing remote content', async () => {
    expect((await call('overrides_get')).content[0].text).not.toContain('token=secret')
    const value = JSON.parse((await call('override_get_content', { id: 'o1' })).content[0].text)
    expect(value.content).toBe('function main() {}')
    await call('override_set_content', { id: 'o1', content: 'new content' })
    expect(mocks.setOverride).toHaveBeenCalledWith('o1', 'js', 'new content')
    expect(mocks.mihomoHotReloadConfig).toHaveBeenCalledOnce()
    mocks.getOverrideItem.mockResolvedValueOnce({ id: 'remote', type: 'remote', ext: 'js' })
    expect((await call('override_set_content', { id: 'remote', content: 'bad' })).isError).toBe(
      true
    )
    expect(mocks.setOverride).toHaveBeenCalledOnce()
  })

  it('creates, updates and removes an override using saved item functions', async () => {
    const created = JSON.parse(
      (await call('override_add_local', { name: 'Local', ext: 'yaml', content: 'mode: rule' }))
        .content[0].text
    )
    expect(mocks.addOverrideItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, type: 'local', file: 'mode: rule' })
    )
    await call('override_update_metadata', { id: 'o1', global: true })
    expect(mocks.updateOverrideItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1', global: true })
    )
    await call('override_remove', { id: 'o1' })
    expect(mocks.removeOverrideItem).toHaveBeenCalledWith('o1')
    expect(mocks.send).toHaveBeenCalledWith('overrideConfigUpdated')
  })

  it('restores the actual previous system proxy preference on failure', async () => {
    mocks.triggerSysProxy.mockRejectedValueOnce(new Error('helper unavailable'))
    const result = await call('sysproxy_set', { enable: false })
    expect(result.isError).toBe(true)
    expect(appConfig.sysProxy).toEqual({ enable: false })
    expect(mocks.send).toHaveBeenCalledWith('appConfigUpdated')
  })
})

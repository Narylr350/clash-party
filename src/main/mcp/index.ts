import { randomBytes } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getAppConfig, patchAppConfig } from '../config'
import { DEFAULT_MCP_PORT } from '../../shared/appConfig'
import { createLogger } from '../utils/logger'
import { registerTools } from './tools'

const mcpLogger = createLogger('Mcp')

const MCP_PATH = '/mcp'
const MAX_BODY_BYTES = 1024 * 1024

let httpServer: ReturnType<typeof createServer> | null = null
let activePort = 0
let activeToken = ''

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'clash-party', version: app.getVersion() })
  registerTools(server)
  return server
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function isAuthorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${activeToken}`
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    })
    return
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null
    })
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: `Invalid request body: ${message}` },
      id: null
    })
    return
  }

  // 无状态模式：每个请求使用独立的 server + transport，避免请求 ID 冲突
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (e) {
    mcpLogger.error('Failed to handle MCP request', e)
    sendJson(res, 500, {
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null
    })
  }
}

async function startMcpServer(port: number, token: string): Promise<void> {
  stopMcpServer()
  const server = createServer((req, res) => {
    if (!(req.url ?? '').startsWith(MCP_PATH)) {
      sendJson(res, 404, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Not found' },
        id: null
      })
      return
    }
    void handleMcpRequest(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  server.on('error', (e) => mcpLogger.error('MCP server error', e))
  httpServer = server
  activePort = port
  activeToken = token
  mcpLogger.info(`MCP server listening at http://127.0.0.1:${port}${MCP_PATH}`)
}

export function stopMcpServer(): void {
  if (httpServer) {
    httpServer.close()
    httpServer.closeAllConnections()
    httpServer = null
  }
  activePort = 0
  activeToken = ''
}

export function getMcpStatus(): { running: boolean; port: number; token: string } {
  return { running: httpServer !== null, port: activePort, token: activeToken }
}

let syncQueue: Promise<void> = Promise.resolve()

export function syncMcpServer(): Promise<void> {
  syncQueue = syncQueue.then(doSyncMcpServer).catch((e) => {
    mcpLogger.error('Failed to sync MCP server', e)
  })
  return syncQueue
}

async function doSyncMcpServer(): Promise<void> {
  const config = await getAppConfig()
  const enabled = config.mcpEnabled !== false
  const port =
    Number.isInteger(config.mcpPort) && (config.mcpPort as number) > 0
      ? (config.mcpPort as number)
      : DEFAULT_MCP_PORT

  if (!enabled) {
    if (httpServer) {
      stopMcpServer()
      mcpLogger.info('MCP server stopped')
    }
    return
  }

  let token = config.mcpToken ?? ''
  if (!token) {
    token = randomBytes(24).toString('base64url')
    await patchAppConfig({ mcpToken: token })
  }

  if (httpServer && activePort === port && activeToken === token) return
  await startMcpServer(port, token)
}

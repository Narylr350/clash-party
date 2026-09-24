import { app } from 'electron'
import { getAppConfig, getControledMihomoConfig } from '../config'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { parse } from '../utils/yaml'
import * as chromeRequest from '../utils/chromeRequest'

const GITHUB_PROXIES = [
  'https://gh-proxy.org',
  'https://ghfast.top',
  'https://down.clashparty.org',
  'https://download.mihomo.party'
]

function buildDownloadUrls(githubUrl: string, proxyPref = ''): string[] {
  if (proxyPref === 'direct') return [githubUrl]
  if (proxyPref && proxyPref !== 'auto') return [`${proxyPref}/${githubUrl}`]
  // auto: try each proxy then fall back to direct
  return [...GITHUB_PROXIES.map((p) => `${p}/${githubUrl}`), githubUrl]
}

async function tryDownload(
  urls: string[],
  options: Parameters<typeof chromeRequest.get>[1]
): Promise<Awaited<ReturnType<typeof chromeRequest.get>>> {
  let lastError: unknown
  for (const url of urls) {
    try {
      const res = await chromeRequest.get(url, options)
      // 代理源限流/失效时会以 200 以外的状态返回错误页，必须当作失败才能继续尝试下一个源
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Request failed with status ${res.status}: ${url}`)
      }
      return res
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

type UpdaterProxy = { protocol: 'http'; host: string; port: number } | false

// 用户关闭混合端口时配置里写的是 0（不是 undefined），解构默认值挡不住。
// 直接拿 0 去拼代理会打到 127.0.0.1:0，检查更新必然失败，所以端口未启用时要显式走直连。
function updaterProxy(mixedPort: number): UpdaterProxy {
  return mixedPort ? { protocol: 'http', host: '127.0.0.1', port: mixedPort } : false
}

export async function checkUpdate(): Promise<IAppVersion | undefined> {
  const [{ 'mixed-port': mixedPort = DEFAULT_MIHOMO_PORTS.mixed }, { githubProxy = '' }] =
    await Promise.all([getControledMihomoConfig(), getAppConfig()])
  const githubUrl =
    'https://github.com/mihomo-party-org/mihomo-party/releases/latest/download/latest.yml'
  const res = await tryDownload(buildDownloadUrls(githubUrl, githubProxy), {
    headers: { 'Content-Type': 'application/octet-stream' },
    proxy: updaterProxy(mixedPort),
    responseType: 'text'
  })
  const latest = parse(res.data as string) as IAppVersion
  // 错误页也能被 YAML 解析成对象（如 `404: Not Found`），不校验会让 compareVersions 崩在 undefined.replace
  if (!latest || typeof latest.version !== 'string') {
    throw new Error('Invalid latest.yml from update source')
  }
  const currentVersion = app.getVersion()
  if (compareVersions(latest.version, currentVersion) > 0) {
    return latest
  } else {
    return undefined
  }
}

// 1:新 -1:旧 0:相同
function compareVersions(a: string, b: string): number {
  const parsePart = (part: string) => {
    const numPart = part.split('-')[0]
    const num = parseInt(numPart, 10)
    return isNaN(num) ? 0 : num
  }
  const v1 = a.replace(/^v/, '').split('.').map(parsePart)
  const v2 = b.replace(/^v/, '').split('.').map(parsePart)
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const num1 = v1[i] || 0
    const num2 = v2[i] || 0
    if (num1 > num2) return 1
    if (num1 < num2) return -1
  }
  return 0
}

// 自编译 fork：官方更新只提示、不安装。安装官方包会覆盖 fork 改动（内置 MCP 等）。
// 维护方式：同步上游后重新 `pnpm build:win --x64` 并重新安装。
export function downloadAndInstallUpdate(version: string): Promise<void> {
  return Promise.reject(
    new Error(
      `fork build: refusing to install official update v${version}; sync upstream and rebuild instead`
    )
  )
}

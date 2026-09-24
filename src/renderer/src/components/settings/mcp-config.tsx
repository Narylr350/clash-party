import React, { useEffect, useState } from 'react'
import SettingCard from '@renderer/components/base/base-setting-card'
import { toast } from '@renderer/components/base/toast'
import SettingItem from '@renderer/components/base/base-setting-item'
import { Button, Chip, Input, Switch } from '@heroui/react'
import { getMcpStatus } from '@renderer/utils/ipc'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import debounce from '@renderer/utils/debounce'
import { useTranslation } from 'react-i18next'
import { DEFAULT_MCP_PORT } from '../../../../shared/appConfig'

const McpConfig: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { mcpEnabled = true, mcpPort = DEFAULT_MCP_PORT, mcpToken = '' } = appConfig || {}
  const [portValue, setPortValue] = useState(mcpPort.toString())
  const [running, setRunning] = useState(false)

  useEffect(() => {
    getMcpStatus()
      .then((status) => setRunning(status.running))
      .catch(() => setRunning(false))
  }, [mcpEnabled, mcpPort])

  const setPort = debounce(async (v: string) => {
    const port = parseInt(v, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return
    try {
      await patchAppConfig({ mcpPort: port })
    } catch (e) {
      toast.error(String(e))
    }
  }, 500)

  const endpoint = `http://127.0.0.1:${mcpPort}/mcp`
  const opencodeConfig = JSON.stringify(
    {
      mcp: {
        'clash-party': {
          type: 'remote',
          url: endpoint,
          headers: { Authorization: `Bearer ${mcpToken}` }
        }
      }
    },
    null,
    2
  )

  const copy = (text: string): void => {
    navigator.clipboard.writeText(text)
    toast.success(t('mcp.copied'))
  }

  return (
    <SettingCard title={t('mcp.title')}>
      <SettingItem title={t('mcp.enable')} divider>
        <Switch
          size="sm"
          isSelected={mcpEnabled}
          onValueChange={async (v) => {
            try {
              await patchAppConfig({ mcpEnabled: v })
            } catch (e) {
              toast.error(String(e))
            }
          }}
        />
      </SettingItem>
      {mcpEnabled && (
        <>
          <SettingItem title={t('mcp.status')} divider>
            <Chip size="sm" variant="flat" color={running ? 'success' : 'default'}>
              {running ? t('mcp.running') : t('mcp.stopped')}
            </Chip>
          </SettingItem>
          <SettingItem title={t('mcp.port')} divider>
            <Input
              size="sm"
              className="w-[60%]"
              value={portValue}
              onValueChange={(v: string) => {
                setPortValue(v)
                setPort(v)
              }}
            />
          </SettingItem>
          <SettingItem title={t('mcp.endpoint')} divider>
            <div className="flex w-[60%] gap-2">
              <Input size="sm" readOnly value={endpoint} />
              <Button size="sm" color="primary" onPress={() => copy(endpoint)}>
                {t('mcp.copy')}
              </Button>
            </div>
          </SettingItem>
          <SettingItem title={t('mcp.token')} divider>
            <div className="flex w-[60%] gap-2">
              <Input size="sm" readOnly value={mcpToken} />
              <Button size="sm" color="primary" onPress={() => copy(mcpToken)}>
                {t('mcp.copy')}
              </Button>
            </div>
          </SettingItem>
          <SettingItem title={t('mcp.opencodeConfig')}>
            <div className="flex w-[60%] gap-2">
              <Input size="sm" readOnly value={opencodeConfig} />
              <Button size="sm" color="primary" onPress={() => copy(opencodeConfig)}>
                {t('mcp.copy')}
              </Button>
            </div>
          </SettingItem>
        </>
      )}
    </SettingCard>
  )
}

export default McpConfig

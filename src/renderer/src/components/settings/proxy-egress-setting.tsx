import { useEffect, useState } from 'react'
import { Divider, Switch, Tooltip } from '@heroui/react'
import useSWR from 'swr'
import { useTranslation } from 'react-i18next'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { getProxyEgressStatus, setPreferWirelessForProxy } from '@renderer/utils/ipc'
import { toast } from '../base/toast'

export default function ProxyEgressSetting(): React.ReactElement {
  const { t } = useTranslation()
  const { appConfig, mutateAppConfig } = useAppConfig()
  const enabled = appConfig?.preferWirelessForProxy === true
  const [saving, setSaving] = useState(false)
  const { data: status, mutate } = useSWR('proxyEgressStatus', getProxyEgressStatus, {
    refreshInterval: enabled ? 2000 : 0
  })
  useEffect(() => {
    void mutate().catch(() => undefined)
  }, [enabled, mutate])
  const text =
    status?.phase === 'error'
      ? t('mihomo.wirelessPriority.error')
      : !enabled
        ? t('mihomo.wirelessPriority.disabled')
        : !status?.proxyInterface
          ? t('mihomo.wirelessPriority.waiting')
          : t('mihomo.wirelessPriority.outlets', {
              proxy: status.proxyInterface,
              direct: status.directInterface ?? status.proxyInterface
            })
  return (
    <>
      <div className="flex min-h-8 w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h4 className="min-w-0 break-words text-md leading-8">
          {t('mihomo.wirelessPriority.title')}
        </h4>
        <div className="flex min-w-0 flex-1 basis-52 items-center justify-end gap-3">
          <Tooltip content={status?.error || text}>
            <span
              className={`min-w-0 break-words text-right text-xs ${status?.phase === 'error' ? 'text-danger' : 'text-foreground-500'}`}
            >
              {text}
            </span>
          </Tooltip>
          <Switch
            size="sm"
            className="shrink-0"
            aria-label={t('mihomo.wirelessPriority.title')}
            isSelected={enabled}
            isDisabled={saving}
            onValueChange={async (value) => {
              setSaving(true)
              try {
                await setPreferWirelessForProxy(value)
              } catch (error) {
                toast.error(String(error))
              } finally {
                mutateAppConfig()
                await mutate().catch(() => undefined)
                setSaving(false)
              }
            }}
          />
        </div>
      </div>
      <Divider className="my-2" />
    </>
  )
}

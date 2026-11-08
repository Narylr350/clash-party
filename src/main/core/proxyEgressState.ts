import type { ProxyEgressSelection } from '../../shared/proxyEgress'
import { applyProxyEgress } from '../sys/proxyEgressPolicy'

let selection: ProxyEgressSelection | null = null

export function getProxyEgressSelection(): ProxyEgressSelection | null {
  return selection
}

export function setProxyEgressSelection(value: ProxyEgressSelection | null): void {
  selection = value
}

export function applyRuntimeProxyEgress<T extends object>(profile: T): T {
  return applyProxyEgress(profile, selection)
}

export function proxyEgressInterfaceNames(): string[] {
  return [
    ...new Set(
      [selection?.proxy?.name, selection?.direct?.name].filter((name): name is string => !!name)
    )
  ]
}

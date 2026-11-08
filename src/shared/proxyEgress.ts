export interface PhysicalInterface {
  guid: string
  name: string
  index: number
  kind: 'wireless' | 'wired' | 'other'
  physical: boolean
  up: boolean
  ipv4: string
  hasDefaultRoute: boolean
  metric: number
}

export interface ProxyEgressSelection {
  proxy: PhysicalInterface | null
  direct: PhysicalInterface | null
}

export interface ProxyEgressStatus {
  enabled: boolean
  phase: 'disabled' | 'waiting' | 'wireless' | 'wired' | 'error'
  proxyInterface: string | null
  directInterface: string | null
  error: string | null
}

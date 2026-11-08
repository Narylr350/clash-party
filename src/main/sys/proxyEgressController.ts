import type {
  PhysicalInterface,
  ProxyEgressSelection,
  ProxyEgressStatus
} from '../../shared/proxyEgress'
import { ProxyEgressPolicy, selectionKey } from './proxyEgressPolicy'

export interface ProxyEgressDependencies {
  read: (signal: AbortSignal) => Promise<PhysicalInterface[]>
  preferredDirect: () => Promise<string | undefined>
  apply: (selection: ProxyEgressSelection | null, signal: AbortSignal) => Promise<void>
  persist: (enabled: boolean) => Promise<void>
  now: () => number
}

export class ProxyEgressController {
  private enabled: boolean
  private selection: ProxyEgressSelection | null = null
  private policy = new ProxyEgressPolicy()
  private generation = 0
  private disposed = false
  private reading = false
  private pending: Promise<unknown> = Promise.resolve()
  private operation = new AbortController()
  private error: string | null = null
  private failedKey: string | undefined
  private retryAfter = 0

  constructor(
    private readonly dependencies: ProxyEgressDependencies,
    enabled = false
  ) {
    this.enabled = enabled
  }

  status(): ProxyEgressStatus {
    return {
      enabled: this.enabled,
      phase: this.error
        ? 'error'
        : !this.enabled
          ? 'disabled'
          : this.selection?.proxy?.kind === 'wireless'
            ? 'wireless'
            : this.selection?.proxy
              ? 'wired'
              : 'waiting',
      proxyInterface: this.selection?.proxy?.name ?? null,
      directInterface: this.selection?.direct?.name ?? null,
      error: this.error
    }
  }

  hasWirelessCandidate(): boolean {
    return this.enabled && this.policy.hasWirelessCandidate()
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work)
    this.pending = next.catch(() => undefined)
    return next
  }

  setEnabled(enabled: boolean): Promise<void> {
    const generation = ++this.generation
    this.operation.abort()
    this.operation = new AbortController()
    const signal = this.operation.signal
    return this.enqueue(async () => {
      if (this.disposed || generation !== this.generation) return
      if (this.enabled === enabled && !this.error) return
      const previous = this.selection
      try {
        if (!enabled) await this.dependencies.apply(null, signal)
        if (signal.aborted) return
        try {
          await this.dependencies.persist(enabled)
        } catch (error) {
          if (!enabled) await this.dependencies.apply(previous, signal)
          throw error
        }
        this.enabled = enabled
        if (!enabled) this.selection = null
        this.policy.reset()
        this.failedKey = undefined
        this.retryAfter = 0
        this.error = null
      } catch (error) {
        if (!signal.aborted)
          this.error = error instanceof Error ? error.message : 'Proxy egress setting failed'
        throw error
      }
    })
  }

  async poll(): Promise<void> {
    if (!this.enabled || this.disposed || this.reading) return
    this.reading = true
    const generation = this.generation
    try {
      const snapshot = await this.dependencies.read(this.operation.signal)
      if (generation !== this.generation || this.disposed) return
      if (this.error === 'Unable to read physical network interfaces; previous egress retained')
        this.error = null
      await this.enqueue(async () => {
        if (!this.enabled || generation !== this.generation || this.disposed) return
        const preferredDirect = await this.dependencies.preferredDirect()
        if (generation !== this.generation || this.disposed) return
        const observed = this.policy.observe(
          snapshot,
          this.selection,
          this.dependencies.now(),
          preferredDirect
        )
        const next = observed.proxy || observed.direct ? observed : null
        const key = selectionKey(next)
        if (
          key === selectionKey(this.selection) ||
          (key === this.failedKey && this.dependencies.now() < this.retryAfter)
        )
          return
        const signal = this.operation.signal
        try {
          await this.dependencies.apply(next, signal)
          if (generation !== this.generation || this.disposed) return
          this.selection = next
          this.failedKey = undefined
          this.error = null
        } catch (error) {
          if (!signal.aborted && generation === this.generation && !this.disposed) {
            this.failedKey = key
            this.retryAfter = this.dependencies.now() + 30000
            this.error = error instanceof Error ? error.message : 'Proxy egress apply failed'
          }
        }
      })
    } catch {
      if (generation === this.generation && !this.disposed) {
        this.policy.interruptObservation()
        this.error = 'Unable to read physical network interfaces; previous egress retained'
      }
    } finally {
      this.reading = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.operation.abort()
  }
}

import type { AppSettings } from '../../shared/types'
import type { AgentEventSink } from '../agent/persistedCallbacks'
import type { BotActivity, BotPlatformRuntime, BotPlatformService } from './contracts'

export interface BotConnectionTestResult {
  name: string
  username?: string
}

export interface BotPlatformRegistration<TConfig> {
  service: BotPlatformService<TConfig>
  selectConfig(settings: AppSettings): TConfig
  normalizeConfig(input: unknown): TConfig
  equivalentConfig(left: TConfig, right: TConfig): boolean
  test(config: TConfig): Promise<BotConnectionTestResult>
}

export interface ManagedBotPlatform {
  channel: string
  runtime: BotPlatformRuntime
  configure(settings: AppSettings): Promise<void>
  changed(next: AppSettings, previous: AppSettings): boolean
  test(input: unknown): Promise<BotConnectionTestResult>
}

/** Erases platform config types only after each registration closes over its validator. */
export function defineBotPlatform<TConfig>(registration: BotPlatformRegistration<TConfig>): ManagedBotPlatform {
  return {
    channel: registration.service.channel,
    runtime: registration.service,
    configure: settings => registration.service.configure(registration.selectConfig(settings)),
    changed: (next, previous) => !registration.equivalentConfig(
      registration.selectConfig(next),
      registration.selectConfig(previous)
    ),
    test: input => registration.test(registration.normalizeConfig(input))
  }
}

/** Process-owned registry for Bot platform lifecycle and configuration dispatch. */
export class BotPlatformManager {
  private readonly platforms = new Map<string, ManagedBotPlatform>()

  constructor(registrations: ManagedBotPlatform[]) {
    for (const registration of registrations) {
      if (this.platforms.has(registration.channel)) {
        throw new Error(`Duplicate Bot platform: ${registration.channel}`)
      }
      this.platforms.set(registration.channel, registration)
    }
  }

  configureAll(settings: AppSettings): Promise<void> {
    return this.configure(this.platforms.values(), settings)
  }

  applySettings(next: AppSettings, previous: AppSettings, force = false): Promise<void> {
    const changed = [...this.platforms.values()].filter(platform => force || platform.changed(next, previous))
    return this.configure(changed, next)
  }

  async test(channel: string, input: unknown): Promise<BotConnectionTestResult> {
    const platform = this.platforms.get(channel)
    if (!platform) throw new Error(`Unknown Bot platform: ${channel}`)
    return platform.test(input)
  }

  setAgentEventSink(sink: AgentEventSink): void {
    for (const platform of this.platforms.values()) platform.runtime.setAgentEventSink(sink)
  }

  setActivityListener(listener: (activity: BotActivity) => boolean | void): void {
    for (const platform of this.platforms.values()) platform.runtime.setActivityListener(listener)
  }

  abortSession(sessionId: string): boolean {
    for (const platform of this.platforms.values()) {
      if (platform.runtime.abortSession(sessionId)) return true
    }
    return false
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.platforms.values()].map(platform => platform.runtime.stop()))
  }

  private async configure(platforms: Iterable<ManagedBotPlatform>, settings: AppSettings): Promise<void> {
    const results = await Promise.allSettled([...platforms].map(async platform => {
      try {
        await platform.configure(settings)
      } catch (error) {
        throw new Error(`${platform.channel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      const reasons = failures.map(failure => failure.reason)
      const detail = reasons.map(reason => reason instanceof Error ? reason.message : String(reason)).join('; ')
      throw new AggregateError(reasons, `Bot platform configuration failed: ${detail}`)
    }
  }
}

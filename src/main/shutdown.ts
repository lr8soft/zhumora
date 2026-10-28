interface QuitEvent { preventDefault(): void }
export interface ShutdownStep { name: string; run(): void | Promise<unknown>; timeoutMs?: number }

/** Main-process quit gate. Windows close only after bounded cleanup settles. */
export class ApplicationShutdown {
  private started = false
  private readyToQuit = false
  private readonly begin: () => void
  private readonly steps: ShutdownStep[]
  private readonly quit: () => void
  private readonly report: (message: string) => void

  constructor(options: { begin: () => void; steps: ShutdownStep[]; quit: () => void; report: (message: string) => void }) {
    this.begin = options.begin; this.steps = options.steps; this.quit = options.quit; this.report = options.report
  }

  beforeQuit(event: QuitEvent): void {
    if (this.readyToQuit) return
    event.preventDefault()
    if (this.started) return
    this.started = true
    try { this.begin() } catch (error) { this.report(`Shutdown initialization failed: ${String(error)}`) }
    void this.complete()
  }

  private async complete(): Promise<void> {
    for (const step of this.steps) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.resolve().then(() => step.run()), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('cleanup timed out')), step.timeoutMs ?? 2500)
        })])
      } catch (error) { this.report(`Shutdown ${step.name}: ${String(error)}`) }
      finally { clearTimeout(timer) }
    }
    this.readyToQuit = true
    this.quit()
  }
}

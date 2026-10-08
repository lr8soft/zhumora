import { AgentAbortedError } from '../../shared/types.ts'

/** Observes late failures even after cancellation/timeout, without retaining listeners or timers. */
function observePromise<T, R>(
  promise: Promise<T>, signal: AbortSignal | undefined, map: (value: T) => R,
  timeout?: { ms: number; value: R }
): Promise<R> {
  return new Promise((resolve, reject) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (finish: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      finish()
    }
    const abort = (): void => settle(() => reject(new AgentAbortedError()))
    promise.then(value => settle(() => resolve(map(value))), error => settle(() => reject(error)))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    if (!done && timeout) {
      if (timeout.ms <= 0) settle(() => resolve(timeout.value))
      else timer = setTimeout(() => settle(() => resolve(timeout.value)), timeout.ms)
    }
  })
}

export function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return observePromise(promise, signal, value => value)
}

/** The caller passes one deadline through every stage of a wait. False means budget exhausted. */
export function waitUntilDeadline(promise: Promise<unknown>, deadline: number, signal?: AbortSignal): Promise<boolean> {
  return observePromise(promise, signal, () => true, { ms: Math.max(0, deadline - Date.now()), value: false })
}

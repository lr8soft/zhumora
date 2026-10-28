import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import { readOutputPage, type ToolOutputReadOptions } from './toolOutputPaging.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const OUTPUT_ID = new RegExp(`^${UUID}$`)
const OUTPUT_FILE = new RegExp(`^${UUID}\\.(?:txt|partial)$`)
const SESSION_DIRECTORY = /^[0-9a-f]{64}$/

export interface ToolOutputStoreOptions {
  ttlMs?: number
  maxResultBytes?: number
  maxSessionBytes?: number
  now?: () => number
}

export interface ToolOutputWriter {
  append(text: string): Promise<void>
  finish(): Promise<string>
  discard(): Promise<void>
}

interface ActiveWriter {
  id: string
  key: string
  temporary: string
  complete: string
  handle: FileHandle
  bytes: number
  pendingSurrogate: string
  tail: Promise<void>
  closed: boolean
  finished: boolean
  error?: unknown
  signal?: AbortSignal
  onAbort?: () => void
}

/** Owns private, session-scoped artifacts. Quota state exists only while that session has writers. */
export class ToolOutputStore {
  private readonly root: string
  private readonly ttlMs: number
  private readonly maxResultBytes: number
  private readonly maxSessionBytes: number
  private readonly now: () => number
  private readonly active = new Map<string, ActiveWriter>()
  private readonly usage = new Map<string, { bytes: number; writers: number }>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly deletions = new Map<string, Promise<void>>()
  private disposed = false

  constructor(rootDirectory: string, options: ToolOutputStoreOptions = {}) {
    this.root = path.resolve(rootDirectory)
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.maxResultBytes = options.maxResultBytes ?? 64 * 1024 * 1024
    this.maxSessionBytes = options.maxSessionBytes ?? 256 * 1024 * 1024
    this.now = options.now ?? Date.now
    for (const value of [this.ttlMs, this.maxResultBytes, this.maxSessionBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Tool output limits must be positive integers')
    }
  }

  async save(sessionId: string, text: string): Promise<string> {
    const writer = await this.createWriter(sessionId)
    try { await writer.append(text); return await writer.finish() }
    catch (error) { await writer.discard(); throw error }
  }

  async createWriter(sessionId: string, signal?: AbortSignal): Promise<ToolOutputWriter> {
    this.assertOpen(); signal?.throwIfAborted()
    const key = this.sessionKey(sessionId)
    this.assertWritableSession(key)
    const writer = await this.lock(key, async () => {
      this.assertOpen(); this.assertWritableSession(key); signal?.throwIfAborted()
      const directory = await this.directory(key, true)
      let usage = this.usage.get(key)
      if (!usage) {
        await this.cleanDirectory(directory)
        let bytes = 0
        for (const name of await fs.readdir(directory)) {
          if (OUTPUT_FILE.test(name)) bytes += (await fs.lstat(path.join(directory, name))).size
        }
        usage = { bytes, writers: 0 }
      }
      const id = randomUUID()
      const temporary = path.join(directory, `${id}.partial`)
      const handle = await fs.open(temporary, 'wx')
      if (this.disposed || this.deletions.has(key) || signal?.aborted) {
        await handle.close(); await fs.rm(temporary, { force: true })
        this.assertOpen(); this.assertWritableSession(key); signal?.throwIfAborted()
      }
      const state: ActiveWriter = { id, key, temporary, complete: path.join(directory, `${id}.txt`), handle,
        bytes: 0, pendingSurrogate: '', tail: Promise.resolve(), closed: false, finished: false, signal }
      usage.writers++; this.usage.set(key, usage); this.active.set(id, state)
      state.onAbort = () => {
        state.error = signal?.reason ?? new Error('Tool output operation aborted')
        void this.queue(state, () => this.discard(state)).catch(error => { state.error = error })
      }
      signal?.addEventListener('abort', state.onAbort, { once: true })
      return state
    })
    return {
      append: text => this.queue(writer, () => this.append(writer, text)),
      finish: () => this.queue(writer, () => this.finish(writer)),
      discard: () => this.queue(writer, () => this.discard(writer))
    }
  }

  async read(sessionId: string, outputId: string, options: ToolOutputReadOptions = {}): Promise<string> {
    this.assertOpen(); options.signal?.throwIfAborted()
    if (!OUTPUT_ID.test(outputId)) throw new Error('Invalid output_id')
    const directory = await this.directory(this.sessionKey(sessionId), false)
    const target = path.join(directory, `${outputId}.txt`)
    let stat
    try { stat = await fs.lstat(target) } catch { throw new Error('Tool output is unavailable or expired') }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Tool output is unavailable or expired')
    if (this.now() - stat.mtimeMs >= this.ttlMs) throw new Error('Tool output has expired')
    return `output_id=${outputId}\n${await readOutputPage(target, options)}`
  }

  async cleanup(): Promise<void> {
    this.assertOpen()
    await fs.mkdir(this.root, { recursive: true })
    for (const name of await fs.readdir(this.root)) {
      if (!SESSION_DIRECTORY.test(name)) continue
      await this.lock(name, async () => { await this.cleanDirectory(await this.directory(name, false)) })
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertOpen()
    const key = this.sessionKey(sessionId)
    const existing = this.deletions.get(key)
    if (existing) return existing
    const deletion = Promise.resolve().then(() => this.removeSession(key))
    this.deletions.set(key, deletion)
    try { await deletion } finally { this.deletions.delete(key) }
  }

  private async removeSession(key: string): Promise<void> {
    for (const writer of [...this.active.values()].filter(item => item.key === key)) {
      await this.queue(writer, () => this.discard(writer))
    }
    await this.lock(key, async () => {
      const directory = await this.directory(key, true)
      for (const name of await fs.readdir(directory)) {
        if (OUTPUT_FILE.test(name)) await fs.rm(path.join(directory, name), { force: true })
      }
      await fs.rmdir(directory)
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.active.values()].map(writer => this.queue(writer, () => this.discard(writer))))
    await Promise.all([...this.deletions.values()])
    // In-flight initialization keeps its own rejection; disposal only waits for it to release resources.
    await Promise.allSettled([...this.locks.values()])
    this.usage.clear()
  }

  private assertOpen(): void { if (this.disposed) throw new Error('Tool output store is disposed') }

  private assertWritableSession(key: string): void {
    if (this.deletions.has(key)) throw new Error('Session tool outputs are being deleted')
  }

  private sessionKey(sessionId: string): string {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('A sessionId is required for tool output')
    return createHash('sha256').update(sessionId).digest('hex')
  }

  private async directory(key: string, create: boolean): Promise<string> {
    const directory = path.join(this.root, key)
    if (create) await fs.mkdir(directory, { recursive: true })
    let stat
    try { stat = await fs.lstat(directory) } catch { throw new Error('Tool output is unavailable or expired') }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid tool output directory')
    return directory
  }

  private async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(action)
    this.locks.set(key, pending)
    try { return await pending } finally { if (this.locks.get(key) === pending) this.locks.delete(key) }
  }

  private queue<T>(writer: ActiveWriter, action: () => Promise<T>): Promise<T> {
    const pending = writer.tail.then(action)
    writer.tail = pending.then(() => {}, () => {})
    return pending
  }

  private async append(writer: ActiveWriter, value: string): Promise<void> {
    if (writer.error) throw writer.error
    if (writer.closed) throw new Error('Tool output writer is closed')
    try {
      this.assertOpen(); writer.signal?.throwIfAborted()
      if (typeof value !== 'string') throw new Error('Tool output must be text')
      let text = writer.pendingSurrogate + value
      writer.pendingSurrogate = /[\uD800-\uDBFF]$/.test(text) ? text.slice(-1) : ''
      if (writer.pendingSurrogate) text = text.slice(0, -1)
      const bytes = Buffer.byteLength(text)
      await this.lock(writer.key, async () => {
        const usage = this.usage.get(writer.key)!
        if (writer.bytes + bytes > this.maxResultBytes) throw new Error('Tool output exceeds the per-result storage quota')
        if (usage.bytes + bytes > this.maxSessionBytes) throw new Error('Tool output exceeds the session storage quota')
        usage.bytes += bytes; writer.bytes += bytes
      })
      await writer.handle.writeFile(text, 'utf8')
    } catch (error) { writer.error = error; await this.discard(writer); throw error }
  }

  private async finish(writer: ActiveWriter): Promise<string> {
    if (writer.error) throw writer.error
    if (writer.finished) return writer.id
    if (writer.closed) throw new Error('Tool output writer is closed')
    try {
      this.assertOpen(); writer.signal?.throwIfAborted()
      if (writer.pendingSurrogate) { writer.pendingSurrogate = ''; await this.append(writer, '\uFFFD') }
      await writer.handle.close(); writer.closed = true
      await fs.rename(writer.temporary, writer.complete)
      const timestamp = new Date(this.now()); await fs.utimes(writer.complete, timestamp, timestamp)
      writer.finished = true
      await this.release(writer, false)
      return writer.id
    } catch (error) { writer.error = error; await this.discard(writer); throw error }
  }

  private async discard(writer: ActiveWriter): Promise<void> {
    if (writer.finished || !this.active.has(writer.id)) return
    if (!writer.closed) { writer.closed = true; await writer.handle.close() }
    await fs.rm(writer.temporary, { force: true })
    await fs.rm(writer.complete, { force: true })
    await this.release(writer, true)
  }

  private async release(writer: ActiveWriter, removed: boolean): Promise<void> {
    await this.lock(writer.key, async () => {
      this.active.delete(writer.id)
      if (writer.onAbort) writer.signal?.removeEventListener('abort', writer.onAbort)
      const usage = this.usage.get(writer.key)!
      if (removed) usage.bytes -= writer.bytes
      if (--usage.writers === 0) this.usage.delete(writer.key)
    })
  }

  private async cleanDirectory(directory: string): Promise<void> {
    for (const name of await fs.readdir(directory)) {
      if (!OUTPUT_FILE.test(name) || this.active.has(name.split('.')[0])) continue
      const target = path.join(directory, name)
      const stat = await fs.lstat(target)
      if (!stat.isSymbolicLink() && stat.isFile() && this.now() - stat.mtimeMs >= this.ttlMs) {
        await fs.rm(target, { force: true })
        const key = path.basename(directory)
        const usage = this.usage.get(key)
        if (usage) usage.bytes -= stat.size
      }
    }
  }
}

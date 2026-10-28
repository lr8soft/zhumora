import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'

interface SourceVersion { revision: string; stat: string }

async function sourceVersion(filePath: string, signal?: AbortSignal): Promise<SourceVersion> {
  const before = await fs.stat(filePath, { bigint: true })
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { signal })
  try {
    for await (const chunk of stream) { signal?.throwIfAborted(); hash.update(chunk) }
  } finally { stream.destroy() }
  const after = await fs.stat(filePath, { bigint: true })
  const key = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  if (key(before) !== key(after)) throw new Error('Office source changed while reading; read again from the beginning or use an existing output_id snapshot')
  return { revision: hash.digest('hex'), stat: key(after) }
}

/** A native continuation addresses one source version, even if the parser reads the path again. */
export async function readStableOfficeScope(
  filePath: string, expectedRevision: string | undefined,
  convert: () => Promise<{ text: string; scope: string }>, signal?: AbortSignal
): Promise<{ text: string; scope: string; sourceRevision: string }> {
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
    throw new Error('source_revision must be the SHA-256 revision returned by the previous Office read')
  }
  signal?.throwIfAborted()
  const before = await sourceVersion(filePath, signal)
  if (expectedRevision && expectedRevision !== before.revision) {
    throw new Error('Office source_revision changed; read again from the beginning or use the existing output_id snapshot')
  }
  const document = await convert()
  signal?.throwIfAborted()
  const after = await sourceVersion(filePath, signal)
  if (before.revision !== after.revision || before.stat !== after.stat) {
    throw new Error('Office source changed during conversion; read again from the beginning or use an existing output_id snapshot')
  }
  // Native and saved-output cursors must use exactly the same logical lines.
  return { ...document, text: document.text.replace(/\r\n?/g, '\n'), sourceRevision: before.revision }
}

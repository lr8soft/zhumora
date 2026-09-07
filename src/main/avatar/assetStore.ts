import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { AvatarAnimationConfig, AvatarModelConfig } from '../../shared/avatar'
import { generateId } from '../id'

export class AvatarAssetStore {
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async importModel(sourcePath: string): Promise<AvatarModelConfig> {
    const managedPath = await this.importFile(sourcePath, '.vrm')
    return {
      id: path.basename(managedPath, '.vrm'),
      name: path.basename(sourcePath, path.extname(sourcePath)),
      filePath: managedPath,
      animations: []
    }
  }

  async importAnimation(sourcePath: string): Promise<AvatarAnimationConfig> {
    const managedPath = await this.importFile(sourcePath, '.vrma')
    return {
      id: path.basename(managedPath, '.vrma'),
      name: path.basename(sourcePath, path.extname(sourcePath)),
      source: 'vrma',
      filePath: managedPath
    }
  }

  async readManagedFile(filePath: string): Promise<Uint8Array> {
    const resolved = this.assertManagedPath(filePath)
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) throw new Error('Avatar asset is not a regular file.')
    return fs.readFile(resolved)
  }

  async removeUnreferenced(previous: AvatarModelConfig[], next: AvatarModelConfig[]): Promise<void> {
    const referenced = new Set(next.flatMap(model => [
      model.filePath,
      ...model.animations.map(animation => animation.filePath).filter((value): value is string => !!value)
    ]).map(filePath => path.resolve(filePath)))
    const removed = previous.flatMap(model => [
      model.filePath,
      ...model.animations.map(animation => animation.filePath).filter((value): value is string => !!value)
    ])
    for (const filePath of removed) {
      const resolved = this.assertManagedPath(filePath)
      if (referenced.has(resolved)) continue
      await fs.unlink(resolved).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private async importFile(sourcePath: string, expectedExtension: '.vrm' | '.vrma'): Promise<string> {
    const source = path.resolve(sourcePath)
    if (path.extname(source).toLowerCase() !== expectedExtension) {
      throw new Error(`Expected a ${expectedExtension} file.`)
    }
    const stat = await fs.stat(source)
    if (!stat.isFile()) throw new Error('Selected Avatar asset is not a regular file.')
    await fs.mkdir(this.root, { recursive: true })
    const destination = path.join(this.root, `${generateId()}${expectedExtension}`)
    await fs.copyFile(source, destination)
    return destination
  }

  private assertManagedPath(filePath: string): string {
    const resolved = path.resolve(filePath)
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error('Avatar asset path is outside the managed Avatar directory.')
    }
    return resolved
  }
}

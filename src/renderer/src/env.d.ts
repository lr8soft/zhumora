// 渲染进程环境类型声明
import type { ZhumoraAPI } from '../../preload/index'
import type { AvatarRendererAPI } from '../../preload/avatar'

declare global {
  interface Window {
    api: ZhumoraAPI
    avatarApi: AvatarRendererAPI
  }
}

export {}

import type {
  DesktopActionRequest,
  DesktopActionResult,
  DesktopObservation,
  DesktopObserveRequest
} from './types'

export type DesktopProcessRequest =
  | { id: number; method: 'observe'; payload: DesktopObserveRequest }
  | { id: number; method: 'action'; payload: DesktopActionRequest }

export type DesktopProcessResponse =
  | { id: number; ok: true; value: DesktopObservation | DesktopActionResult }
  | { id: number; ok: false; error: SerializedDesktopError }

export interface SerializedDesktopError {
  name: string
  message: string
  stack?: string
}

export function isDesktopProcessRequest(value: unknown): value is DesktopProcessRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<DesktopProcessRequest>
  return Number.isSafeInteger(request.id)
    && (request.method === 'observe' || request.method === 'action')
    && !!request.payload
    && typeof request.payload === 'object'
}

export function isDesktopProcessResponse(value: unknown): value is DesktopProcessResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<DesktopProcessResponse>
  return Number.isSafeInteger(response.id) && typeof response.ok === 'boolean'
}

import assert from 'node:assert/strict'
import {
  isValidTelegramBotToken,
  splitTelegramText,
  TelegramApiError,
  TelegramHttpClient
} from '../src/main/telegram/client.ts'

assert.equal(isValidTelegramBotToken('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123'), true)
assert.equal(isValidTelegramBotToken('not-a-token'), false)
assert.deepEqual(splitTelegramText('😀😀😀', 2), ['😀😀', '😀'])

const requests: Array<{ url: string; body: any }> = []
const fetchOk = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const body = JSON.parse(String(init?.body || '{}'))
  requests.push({ url, body })
  const result = url.endsWith('/getMe')
    ? { id: 42, is_bot: true, first_name: 'Zhumora', username: 'zhumora_bot' }
    : url.endsWith('/getUpdates')
      ? [{ update_id: 7, message: { message_id: 3, chat: { id: 9, type: 'private' }, text: 'hello' } }]
      : { message_id: 4 }
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}) as typeof fetch

const client = new TelegramHttpClient('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123', fetchOk)
const me = await client.getMe()
assert.equal(me.id, 42)
const updates = await client.getUpdates(7)
assert.equal(updates[0].update_id, 7)
await client.sendText(9, 'hello', { replyToMessageId: 3 })
assert.match(requests[0].url, /\/getMe$/)
assert.deepEqual(requests[1].body, { offset: 7, timeout: 25, allowed_updates: ['message'] })
assert.deepEqual(requests[2].body, {
  chat_id: 9,
  text: 'hello',
  reply_parameters: { message_id: 3 }
})

const fetchLimited = (async () => new Response(JSON.stringify({
  ok: false,
  error_code: 429,
  description: 'Too Many Requests',
  parameters: { retry_after: 5 }
}), { status: 429, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
const limited = new TelegramHttpClient('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123', fetchLimited)
await assert.rejects(
  () => limited.getUpdates(undefined),
  (error: unknown) => error instanceof TelegramApiError
    && error.errorCode === 429
    && error.retryAfterSeconds === 5
)

console.log('Telegram HTTP API tests passed')

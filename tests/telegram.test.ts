import assert from 'node:assert/strict'
import {
  isValidTelegramBotToken,
  splitTelegramText,
  TelegramApiError,
  TelegramHttpClient
} from '../src/main/telegram/client.ts'
import {
  formatPermissionPrompt,
  isPermissionCallbackAuthorized,
  parsePermissionCallback,
  permissionCallbackData
} from '../src/main/telegram/permissionPresenter.ts'
import { TelegramResponseStream } from '../src/main/telegram/responseStream.ts'

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
      : url.endsWith('/sendMessageDraft') || url.endsWith('/answerCallbackQuery')
        ? true
        : { message_id: 4, chat: { id: 9, type: 'private' } }
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
assert.deepEqual(requests[1].body, { offset: 7, timeout: 25, allowed_updates: ['message', 'callback_query'] })
assert.deepEqual(requests[2].body, {
  chat_id: 9,
  text: 'hello',
  reply_parameters: { message_id: 3 }
})

await client.sendDraft(9, 12, 'partial')
assert.deepEqual(requests[3].body, { chat_id: 9, draft_id: 12, text: 'partial' })
const permissionMessage = await client.sendPermissionPrompt(9, 'Approve?', {
  inline_keyboard: [[{ text: 'Allow', callback_data: 'p:1' }]]
})
assert.equal(permissionMessage.message_id, 4)
await client.answerCallbackQuery('callback-1', 'Approved.')
assert.deepEqual(requests[5].body, {
  callback_query_id: 'callback-1', text: 'Approved.', show_alert: false
})

const callbackData = permissionCallbackData('perm123', true)
assert.equal(callbackData, 'zhp:perm123:1')
assert.deepEqual(parsePermissionCallback(callbackData), { permissionId: 'perm123', allowed: true })
assert.equal(parsePermissionCallback('bad'), null)
const callbackQuery = {
  id: 'q1',
  from: { id: 7, is_bot: false, first_name: 'User' },
  message: { message_id: 4, chat: { id: 9, type: 'private' as const } },
  data: callbackData
}
assert.equal(isPermissionCallbackAuthorized({ permissionId: 'perm123', senderId: 7, chatId: 9 }, callbackQuery, ['7']), true)
assert.equal(isPermissionCallbackAuthorized({ permissionId: 'perm123', senderId: 8, chatId: 9 }, callbackQuery, ['7']), false)
assert.equal(isPermissionCallbackAuthorized({ permissionId: 'perm123', senderId: 7, chatId: 10 }, callbackQuery, ['7']), false)
const prompt = formatPermissionPrompt({
  id: 'p1', sessionId: 's1', toolName: 'write', level: 'normal',
  args: { path: 'a.txt', apiToken: 'secret' }
})
assert.match(prompt, /a\.txt/)
assert.doesNotMatch(prompt, /secret/)

const stream = new TelegramResponseStream(client, {
  message_id: 8,
  from: { id: 1, is_bot: false, first_name: 'User' },
  chat: { id: 9, type: 'private' },
  text: 'question'
})
stream.events.token?.('s1', 'm1', 'draft text')
await new Promise(resolve => setTimeout(resolve, 750))
stream.events.assistantEnd?.('s1', 'm1', 'round one', [])
await stream.flush()
assert.ok(requests.some(request => request.url.endsWith('/sendMessageDraft') && request.body.text === 'draft text'))
assert.ok(requests.some(request => request.url.endsWith('/sendMessage') && request.body.text === 'round one'))

// 思考草稿 + 工具进度实时显示（用户不会以为 bot 卡死）
const progressStream = new TelegramResponseStream(client, {
  message_id: 20,
  from: { id: 1, is_bot: false, first_name: 'User' },
  chat: { id: 9, type: 'private' },
  text: 'do stuff'
})
progressStream.events.reasoning?.('s1', 'm2', 'thinking hard')
await new Promise(resolve => setTimeout(resolve, 750))
assert.ok(requests.some(request =>
  request.url.endsWith('/sendMessageDraft') && request.body.text === '💭 thinking hard'
))
progressStream.events.toolCall?.('s1', 'm2', {
  id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' }
})
await new Promise(resolve => setTimeout(resolve, 10))
assert.ok(requests.some(request =>
  request.url.endsWith('/sendMessage') && request.body.text === '🔧 bash: npm test'
))
progressStream.events.toolResult?.(
  { id: 'tm1', sessionId: 's1', role: 'tool', content: 'ok', toolCallId: 'tc1', toolName: 'bash', timestamp: 1 },
  'tc1', 'bash', 'ok', false, 1234
)
await progressStream.flush()
assert.ok(requests.some(request =>
  request.url.endsWith('/editMessageText') && request.body.text === '🔧 bash: npm test\n✅ 1.2s'
))

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

// getFile + 文件下载（图片消息多模态管线依赖）
const fileRequests: string[] = []
const fetchFile = (async (input: string | URL | Request) => {
  const url = String(input)
  fileRequests.push(url)
  if (url.includes('/getFile')) {
    return new Response(JSON.stringify({
      ok: true,
      result: { file_id: 'f1', file_unique_id: 'u1', file_size: 3, file_path: 'photos/file_1.jpg' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
}) as typeof fetch
const fileClient = new TelegramHttpClient('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123', fetchFile)
const file = await fileClient.getFile('f1')
assert.equal(file.file_path, 'photos/file_1.jpg')
const base64 = await fileClient.downloadFileAsBase64(file.file_path!)
assert.equal(base64, '/9j/')
assert.ok(fileRequests.some(request => request.includes('/file/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123/photos/file_1.jpg')))

// 带图消息（photo + caption，无 text 字段）能被解析
const photoUpdate: { update_id: number; message: import('../src/main/telegram/client.ts').TelegramMessage } = {
  update_id: 11,
  message: {
    message_id: 5,
    chat: { id: 9, type: 'private' },
    caption: '看看这张图',
    photo: [{ file_id: 'small', file_unique_id: 'a', width: 90, height: 90 }]
  }
}
assert.equal(photoUpdate.message.caption, '看看这张图')
assert.equal(photoUpdate.message.photo?.at(-1)?.file_id, 'small')

console.log('Telegram HTTP API tests passed')

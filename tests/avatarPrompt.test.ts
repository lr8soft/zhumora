import assert from 'node:assert/strict'
import { buildAvatarSystemPrompt } from '../src/main/avatar/prompt.ts'

const readyPrompt = buildAvatarSystemPrompt('anime_freak_free', ['Idle', 'Wave'], {
  animations: ['Idle', 'Wave'],
  expressions: ['neutral', 'happy', 'Surprised'],
  defaultAnimation: 'Idle',
  intents: ['idle', 'greet', 'acknowledge']
}, true)

assert.match(readyPrompt, /Available animation names \(case-sensitive; use exact spelling\): Idle, Wave\./)
assert.match(readyPrompt, /Available expression names \(case-sensitive; use exact spelling\): neutral, happy, Surprised\./)
assert.match(readyPrompt, /default animation "Idle" is already playing in a loop/)
assert.match(readyPrompt, /Never invent an animation or expression name/)
assert.match(readyPrompt, /action="perform"/)
assert.match(readyPrompt, /active response channel/)
assert.match(readyPrompt, /For each new user request, proactively include one meaningful avatar_control/)
assert.match(readyPrompt, /Do not wait for the user to ask for a gesture/)
assert.match(readyPrompt, /already succeeded for the current user request, do not call it again/)
assert.match(readyPrompt, /semantic gesture for the response must be selected with avatar_control/)

const pendingPrompt = buildAvatarSystemPrompt('loading', [], { animations: [], expressions: [] }, false)
assert.match(pendingPrompt, /capability scan is not ready/)
assert.match(pendingPrompt, /Do not guess/)
assert.doesNotMatch(pendingPrompt, /proactively include one meaningful avatar_control/)

console.log('avatar prompt tests passed')

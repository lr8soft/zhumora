import assert from 'node:assert/strict'
import { buildAvatarSystemPrompt } from '../src/main/avatar/prompt.ts'

const trainedActions = ['idle', 'speak', 'wave', 'greet', 'point', 'celebrate', 'surprised', 'phone', 'drink', 'encourage', 'bow', 'spin']
const readyPrompt = buildAvatarSystemPrompt('anime_freak_free', ['Idle', 'Wave'], {
  animations: ['Idle', 'Wave'],
  expressions: ['neutral', 'happy', 'Surprised'],
  defaultAnimation: 'Idle',
  intents: ['idle', 'greet', 'acknowledge'],
  textMotionActions: trainedActions
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
assert.match(readyPrompt, /wave=wave one hand/)
assert.match(readyPrompt, /shrug=raise shoulders/)
assert.match(readyPrompt, /bow=bow deeply/)
assert.match(readyPrompt, /applaud=clap hands/)
assert.match(readyPrompt, /Built-in motions stay upper-body and in place\./)
assert.match(readyPrompt, /wave for casual hello or goodbye/)
assert.match(readyPrompt, /action="generate_motion"/)
assert.match(readyPrompt, /trained for these perform intents: idle, greet, celebrate, wave, bow\./,
  'the prompt names only the intents the local model actually covers')
assert.match(readyPrompt, /Every other intent uses its built-in procedural motion/)
assert.match(readyPrompt, /Its trained actions are: idle, speak, wave, greet, point, celebrate, surprised, phone, drink, encourage, bow, spin\./)

const builtInPrompt = buildAvatarSystemPrompt('anime_freak_free', ['Idle'], {
  animations: ['Idle'],
  expressions: [],
  defaultAnimation: 'Idle',
  intents: ['idle', 'wave']
}, true)
assert.doesNotMatch(builtInPrompt, /trained for these perform intents/)
assert.doesNotMatch(builtInPrompt, /generate_motion/)

const pendingPrompt = buildAvatarSystemPrompt('loading', [], { animations: [], expressions: [] }, false)
assert.match(pendingPrompt, /capability scan is not ready/)
assert.match(pendingPrompt, /Do not guess/)
assert.doesNotMatch(pendingPrompt, /proactively include one meaningful avatar_control/)

console.log('avatar prompt tests passed')

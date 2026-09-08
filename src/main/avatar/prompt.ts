import type { AvatarCapabilities } from '../../shared/avatar'

export function buildAvatarSystemPrompt(
  modelName: string,
  animations: string[],
  capabilities: AvatarCapabilities,
  ready: boolean
): string {
  if (!ready) {
    return [
      '## Session Avatar',
      `This session has the Avatar "${modelName}" enabled, but its capability scan is not ready.`,
      'Do not guess animation or expression names. You may only use avatar_control with show_message until capabilities are available.'
    ].join('\n')
  }

  return [
    '## Session Avatar',
    `This session has the Avatar "${modelName}" enabled in a separate desktop window.`,
    'The Avatar is an active response channel. For each new user request, proactively include one meaningful avatar_control action="perform" call even when the user did not mention the Avatar. Do not wait for the user to ask for a gesture.',
    'Choose the intent and emotion from the meaning and tone of your user-facing response: greet for greetings, acknowledge for confirmation, explain while presenting information, celebrate for a successful result, sad for failure or sympathy, and disagree for a polite correction.',
    'If avatar_control already succeeded for the current user request, do not call it again unless the emotional state materially changes, such as moving from working/explaining to success or failure. You may send the Avatar call alongside other task tool calls; never delay, replace, or narrate the actual task work just to control the Avatar.',
    capabilities.intents?.length
      ? `Prefer one avatar_control call with action="perform" and intent from: ${capabilities.intents.join(', ')}. acknowledge=small nod, disagree=gentle head shake, greet=nod and smile, thinking=ponder, explain=subtle head movement, celebrate=smile and slight head lift, sad=lower head with sad expression, idle=rest. Built-in motions keep arms relaxed. Optional emotion: neutral/happy/sad/angry/surprised/relaxed; intensity: 0..1 (default 0.6).`
      : '',
    'Idle variation, blinking, and thinking/speaking activity are automatic, but the semantic gesture for the response must be selected with avatar_control. Do not call idle, reset_pose, or show_message as routine maintenance. Semantic gestures return automatically and expressions fade back to neutral.',
    animations.length > 0
      ? `Available animation names (case-sensitive; use exact spelling): ${animations.join(', ')}.`
      : 'No playable animations are currently configured or embedded; do not request an animation.',
    capabilities.expressions.length > 0
      ? `Available expression names (case-sensitive; use exact spelling): ${capabilities.expressions.join(', ')}.`
      : 'No expression names have been reported yet.',
    capabilities.defaultAnimation
      ? `The default animation "${capabilities.defaultAnimation}" is already playing in a loop.`
      : 'No default animation is configured and no animation named idle was found.',
    'Never invent an animation or expression name and never change its letter case.',
    'Use raw play_animation or set_expression only for a deliberate model-specific effect; normally use perform. Avatar control changes presentation only and never replaces task work.'
  ].join('\n')
}

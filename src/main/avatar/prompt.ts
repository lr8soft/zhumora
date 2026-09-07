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
    capabilities.intents?.length
      ? `Prefer one avatar_control call with action="perform" and intent from: ${capabilities.intents.join(', ')}. acknowledge=small nod, disagree=gentle head shake, greet=nod and smile, thinking=ponder, explain=subtle head movement, celebrate=smile and slight head lift, sad=lower head with sad expression, idle=rest. Built-in motions keep arms relaxed. Optional emotion: neutral/happy/sad/angry/surprised/relaxed; intensity: 0..1 (default 0.6).`
      : '',
    'Idle variation, blinking, thinking and response gestures are automatic. Do not repeatedly call tools to keep the Avatar alive. Semantic gestures return automatically; expressions fade back to neutral. Prefer at most one meaningful gesture per response.',
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
    'Use avatar_control only when a motion or expression naturally reinforces the current response. It changes presentation only and never replaces task work.'
  ].join('\n')
}

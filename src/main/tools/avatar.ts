import type { AvatarCommand } from '../../shared/avatar'
import { AVATAR_INTENTS, AVATAR_EMOTIONS, type AvatarIntent, type AvatarEmotion } from '../../shared/avatar.ts'
import type { ToolHandler } from './registry'
import type { AvatarController } from '../avatar/contracts'

export function createAvatarTools(controller: AvatarController): Array<{ name: string; handler: ToolHandler }> {
  const handler: ToolHandler = {
    definition: {
      type: 'function',
      function: {
        name: 'avatar_control',
        description: [
          'Control the optional VRM Avatar attached to this session.',
          'When the Session Avatar system section is present, proactively use action=perform for each new user request; the user does not need to ask for a gesture.',
          'Prefer action=perform: choose an intent and optional emotion in one call. Idle, blinking and activity gestures run automatically.',
          'Use only exact animation/expression names listed in the Session Avatar system section.',
          'This is presentation-only: never use it instead of completing the user task.'
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['perform', 'play_animation', 'set_expression', 'reset_pose', 'show_message'] },
            intent: { type: 'string', enum: [...AVATAR_INTENTS], description: 'perform: idle=rest, thinking=ponder, explain=subtle head movement, acknowledge=nod, disagree=shake head, greet=nod and smile, celebrate=smile and slight head lift, sad=lower head and sad expression. Built-in motions keep arms relaxed.' },
            emotion: { type: 'string', enum: [...AVATAR_EMOTIONS] },
            intensity: { type: 'number', minimum: 0, maximum: 1, description: 'perform strength, default 0.6; automatically returns to current activity.' },
            animation: { type: 'string', description: 'Required for play_animation.' },
            loop: { type: 'boolean', description: 'Whether to loop the animation. Default false.' },
            expression: { type: 'string', description: 'Required for set_expression.' },
            value: { type: 'number', minimum: 0, maximum: 1, description: 'Expression weight. Default 1.' },
            message: { type: 'string', description: 'Required for show_message. Displayed as one truncated line.' }
          },
          required: ['action'],
          additionalProperties: false
        }
      }
    },
    // Motions change a visible desktop window. Keep the standard permission policy:
    // manual mode confirms; auto/full mode can run presentation updates in real time.
    permission: 'normal',
    async execute(args, ctx) {
      const action = String(args.action || '')
      let command: AvatarCommand
      if (action === 'perform') {
        if (!AVATAR_INTENTS.includes(args.intent as AvatarIntent)) return { content: 'perform requires a valid intent.', isError: true }
        if (args.emotion !== undefined && !AVATAR_EMOTIONS.includes(args.emotion as AvatarEmotion)) return { content: 'Invalid Avatar emotion.', isError: true }
        if (args.intensity !== undefined && (typeof args.intensity !== 'number' || !Number.isFinite(args.intensity) || args.intensity < 0 || args.intensity > 1)) {
          return { content: 'intensity must be a finite number from 0 to 1.', isError: true }
        }
        command = { type: 'perform', intent: args.intent as AvatarIntent, emotion: args.emotion as AvatarEmotion | undefined, intensity: typeof args.intensity === 'number' ? args.intensity : 0.6 }
      } else if (action === 'play_animation') {
        const animation = String(args.animation || '').trim()
        if (!animation) return { content: 'play_animation requires "animation".', isError: true }
        command = { type: 'play_animation', animation, loop: args.loop === true }
      } else if (action === 'set_expression') {
        const expression = String(args.expression || '').trim()
        if (!expression) return { content: 'set_expression requires "expression".', isError: true }
        if (args.value !== undefined && (typeof args.value !== 'number' || !Number.isFinite(args.value))) return { content: 'value must be a finite number.', isError: true }
        const value = typeof args.value === 'number' ? Math.min(1, Math.max(0, args.value)) : 0.7
        command = { type: 'set_expression', expression, value }
      } else if (action === 'reset_pose') {
        command = { type: 'reset_pose' }
      } else if (action === 'show_message') {
        const message = String(args.message || '').trim()
        if (!message) return { content: 'show_message requires "message".', isError: true }
        command = { type: 'show_message', message }
      } else {
        return { content: `Unknown Avatar action "${action}".`, isError: true }
      }
      return controller.execute(ctx.sessionId, command, ctx.signal)
    }
  }
  return [{ name: 'avatar_control', handler }]
}

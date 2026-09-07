import type { AvatarCommand } from '../../shared/avatar'
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
          'Use only exact animation/expression names listed in the Session Avatar system section.',
          'This is presentation-only: never use it instead of completing the user task.'
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['play_animation', 'set_expression', 'reset_pose', 'show_message'] },
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
      if (action === 'play_animation') {
        const animation = String(args.animation || '').trim()
        if (!animation) return { content: 'play_animation requires "animation".', isError: true }
        command = { type: 'play_animation', animation, loop: args.loop === true }
      } else if (action === 'set_expression') {
        const expression = String(args.expression || '').trim()
        if (!expression) return { content: 'set_expression requires "expression".', isError: true }
        const value = typeof args.value === 'number' ? Math.min(1, Math.max(0, args.value)) : 1
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

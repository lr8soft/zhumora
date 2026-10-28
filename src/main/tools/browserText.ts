import type { Page } from 'playwright'
import type { ToolContext } from './registry.ts'
import { browserTextPreview } from './outputLimits.ts'
import { recoverableToolOutput } from './recoverableOutput.ts'

/** Capture one immutable page/selector result before applying the model preview budget. */
export async function readBrowserText(
  args: Record<string, unknown>, ctx: ToolContext, getPage: () => Promise<Pick<Page, 'locator'>>, html = false
) {
  try {
    ctx.signal?.throwIfAborted()
    const page = await getPage()
    const selector = (args.selector as string) || 'body'
    const element = page.locator(selector).first()
    const content = (html ? await element.innerHTML() : await element.innerText({ timeout: 10000 })) || (html ? '(no html)' : '(no text found)')
    ctx.signal?.throwIfAborted()
    return await recoverableToolOutput(content, ctx, 'Use the saved snapshot to search or continue reading this page.',
      undefined, browserTextPreview(content, args.max_length))
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    return { content: `Error getting ${html ? 'HTML' : 'text'}: ${(error as Error).message}`, isError: true }
  }
}

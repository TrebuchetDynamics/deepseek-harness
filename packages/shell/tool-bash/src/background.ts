/**
 * Generic-task adaptation for background bash process handles.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */

import type { ShellProcess } from '@deepseek-ai/dsh-shell'

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * infrastructure failures become `failed`; `killed` stays `killed` (detail: the
 * signal when one is known); everything else is `completed` with the exit code.
 * A nonzero command exit is reported, not failed, like the foreground rendering.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc: ShellProcess): { status: 'completed' | 'killed' | 'failed'; detail: string } {
  if (proc.sandbox?.runnerFailed === true) {
    return { status: 'failed', detail: 'sandbox runner failure' }
  }
  if (proc.infrastructureFailed === true) {
    return { status: 'failed', detail: 'process infrastructure failure' }
  }
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

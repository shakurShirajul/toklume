import { hash128 } from '../shared.js'

/**
 * Build the dedupe key for a Claude Code entry.
 *
 * Content-derived wherever possible: resumed sessions copy earlier messages
 * into a new file, so a file-derived key would double-count them. The hash
 * fallback includes the source file only because a line with no message id has
 * no other stable identity.
 */
export function claudeDedupeKey(
  messageId: string | undefined,
  requestId: string | undefined,
  sourceFile: string,
  rawLine: string,
): string {
  if (messageId && requestId) return `cc:${messageId}:${requestId}`
  if (messageId) return `cc:${messageId}`
  return `cc:${hash128(`${sourceFile} ${rawLine}`)}`
}

import { openSync, readSync, closeSync, statSync } from 'node:fs'
import type { Parser } from '../parsers/types.js'
import type { Writer } from '../db/queries.js'
import { errorMessage } from './paths.js'

export interface FileScanResult {
  sourceFile: string
  status: 'skipped' | 'scanned' | 'failed'
  inserted: number
  duplicates: number
  malformed: number
  /** Set when status === 'failed'. */
  error?: string
}

export interface ScanSummary {
  filesScanned: number
  filesSkipped: number
  inserted: number
  duplicates: number
  malformed: number
  failures: { sourceFile: string; error: string }[]
}

function emptySummary(): ScanSummary {
  return {
    filesScanned: 0,
    filesSkipped: 0,
    inserted: 0,
    duplicates: 0,
    malformed: 0,
    failures: [],
  }
}

/**
 * Read new bytes from `offset` to end of file.
 *
 * Returns the decoded text plus the number of bytes consumed. A trailing
 * partial line (no final newline) is NOT returned: the writer may still be
 * mid-write, so we leave the offset at the start of that line and pick it up
 * once it is complete.
 */
export function readNewLines(
  file: string,
  offset: number,
  size: number,
): { lines: string[]; consumed: number } {
  if (size <= offset) return { lines: [], consumed: 0 }

  const length = size - offset
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  let bytesRead: number
  try {
    bytesRead = readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }

  const chunk = buffer.subarray(0, bytesRead)
  const lastNewline = chunk.lastIndexOf(0x0a) // '\n'
  if (lastNewline === -1) {
    // No complete line in this chunk yet.
    return { lines: [], consumed: 0 }
  }

  const complete = chunk.subarray(0, lastNewline + 1)
  const text = complete.toString('utf8')
  const lines = text.split('\n')
  // split on a trailing newline leaves a final empty element; drop it.
  if (lines[lines.length - 1] === '') lines.pop()

  return { lines, consumed: complete.byteLength }
}

/**
 * Scan one file incrementally and persist any events it yields.
 *
 * Decides what to read based on stored scan_state:
 *  - unchanged size+mtime  -> skip without opening the file
 *  - grew                  -> read from stored offset
 *  - shrank or mtime moved
 *    backwards              -> treat as rotated/replaced, re-read from 0
 *                              (dedupe keys make the re-read a no-op)
 */
export function scanFile(parser: Parser, writer: Writer, file: string): FileScanResult {
  const base: FileScanResult = {
    sourceFile: file,
    status: 'scanned',
    inserted: 0,
    duplicates: 0,
    malformed: 0,
  }

  let stat
  try {
    stat = statSync(file)
  } catch (err) {
    return { ...base, status: 'failed', error: errorMessage(err) }
  }

  const size = stat.size
  const mtime = Math.floor(stat.mtimeMs)
  const prior = writer.getScanState(file)

  if (prior && prior.size === size && prior.mtime === mtime) {
    return { ...base, status: 'skipped' }
  }

  let offset = prior?.byte_offset ?? 0
  if (prior && (size < prior.size || mtime < prior.mtime)) {
    offset = 0 // rotated or replaced
  }
  if (offset > size) offset = 0

  try {
    const { lines, consumed } = readNewLines(file, offset, size)

    // Nothing complete to read, but size/mtime changed: record the new stat so
    // an unchanged file is skipped next time, keeping the offset where it is.
    if (lines.length === 0) {
      writer.commitFile([], { sourceFile: file, size, mtime, byteOffset: offset })
      return { ...base, status: 'scanned' }
    }

    const { events, skipped } = parser.parseLines(lines, file, {
      fileMtime: Math.floor(stat.mtimeMs / 1000),
    })

    const { inserted, duplicates } = writer.commitFile(events, {
      sourceFile: file,
      size,
      mtime,
      byteOffset: offset + consumed,
    })

    return { ...base, inserted, duplicates, malformed: skipped }
  } catch (err) {
    // Offset is not advanced, so the same bytes are retried next sync.
    return { ...base, status: 'failed', error: errorMessage(err) }
  }
}

/** Scan every file a parser reports, accumulating a summary. */
export function scanParser(parser: Parser, writer: Writer, files: string[]): ScanSummary {
  const summary = emptySummary()

  for (const file of files) {
    const result = scanFile(parser, writer, file)
    if (result.status === 'skipped') {
      summary.filesSkipped += 1
      continue
    }
    if (result.status === 'failed') {
      summary.failures.push({ sourceFile: result.sourceFile, error: result.error ?? 'unknown' })
      continue
    }
    summary.filesScanned += 1
    summary.inserted += result.inserted
    summary.duplicates += result.duplicates
    summary.malformed += result.malformed
  }

  return summary
}


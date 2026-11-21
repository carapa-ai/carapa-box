import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';

export interface JournalCursor { offset: number }

/** Read only new, complete frames. Offsets are byte offsets, including for UTF-8. */
export function readJournal(path: string, cursor: JournalCursor, capture?: string): string[] {
  let fd: number | undefined;
  let complete: Buffer;
  try {
    const size = statSync(path).size;
    if (size < cursor.offset) throw new Error(`Protocol journal was truncated: ${path}`);
    if (size === cursor.offset) return [];
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(size - cursor.offset);
    const count = readSync(fd, buffer, 0, buffer.length, cursor.offset);
    const available = buffer.subarray(0, count);
    const newline = available.lastIndexOf(10);
    if (newline < 0) return [];
    complete = available.subarray(0, newline + 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (capture) appendFileSync(capture, complete);
  cursor.offset += complete.length;
  return complete.toString('utf8').split('\n').filter(Boolean);
}

export function decodeObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Raw journals retain malformed provider diagnostics. */ }
}

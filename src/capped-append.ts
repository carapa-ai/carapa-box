// Dependency-free so it can be imported without pulling in utils.ts (config, logger, compose client).

export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB cap

export function cappedAppend(current: string, chunk: string): string {
    if (current.length >= MAX_OUTPUT_BYTES) return current;
    const result = current + chunk;
    if (result.length > MAX_OUTPUT_BYTES) {
        return result.slice(0, MAX_OUTPUT_BYTES) + "\n...[truncated]";
    }
    return result;
}

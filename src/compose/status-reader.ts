export interface StatusReadOptions {
    /** Start a new read instead of joining one already in flight (for callers that just changed the stack). */
    fresh?: boolean;
}

type StatusReader<T> = (stack: string, project?: string, options?: StatusReadOptions) => Promise<T>;

/** Bound status polling across all clients, sharing simultaneous identical reads. */
export function boundedStatusReader<T>(read: StatusReader<T>): StatusReader<T> {
    const pending = new Map<string, Promise<T>>();
    const waiting: Array<() => void> = [];
    let active = 0;
    return (stack, project, options) => {
        const key = JSON.stringify([stack, project]);
        const existing = options?.fresh ? undefined : pending.get(key);
        if (existing) return existing;
        let result!: Promise<T>; // Assigned below; the executor compares itself against the map entry.
        result = (async () => {
            await Promise.resolve(); // Publish the in-flight read before invoking its executor.
            if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve));
            else active++;
            try {
                return await read(stack, project);
            } finally {
                // A fresh read may have replaced this entry; leave its entry alone.
                if (pending.get(key) === result) pending.delete(key);
                const next = waiting.shift();
                if (next) next();
                else active--;
            }
        })();
        pending.set(key, result);
        return result;
    };
}

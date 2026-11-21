/** Tracks in-flight tool calls so SIGTERM can wait for them before exiting. */

export const DEFAULT_SHUTDOWN_DRAIN_MS = 120_000;

let inflight = 0;
let draining = false;

function beginToolCall(): void {
    inflight++;
}

function endToolCall(): void {
    if (inflight > 0) inflight--;
}

export function inflightCount(): number {
    return inflight;
}

export function startDraining(): void {
    draining = true;
}

export function isDraining(): boolean {
    return draining;
}

/** Test helper: restore the initial state. */
export function resetDrainState(): void {
    inflight = 0;
    draining = false;
}

const RESTARTING_MESSAGE = "carapa-box is restarting; retry in a few seconds";

/** Wrap a tool handler: refuse while draining, otherwise count it until it settles. */
export function trackToolCall<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R | { content: { type: "text"; text: string }[]; isError: true }> {
    return async (...args: A) => {
        if (draining) {
            return { content: [{ type: "text" as const, text: RESTARTING_MESSAGE }], isError: true as const };
        }
        beginToolCall();
        try {
            return await fn(...args);
        } finally {
            endToolCall();
        }
    };
}

/** Parse CARAPA_BOX_SHUTDOWN_DRAIN_MS; unset, invalid or negative values give the default. */
export function drainLimitFromEnv(raw: string | undefined = process.env.CARAPA_BOX_SHUTDOWN_DRAIN_MS): number {
    if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_DRAIN_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHUTDOWN_DRAIN_MS;
}

/** Resolves true once no calls are in flight, false when limitMs elapses first. */
export async function waitForIdle(
    limitMs: number,
    pollMs = 100,
    onTick?: (remaining: number) => void,
    tickEveryMs = 5_000
): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    let nextTick = Date.now() + tickEveryMs;
    while (inflight > 0) {
        const now = Date.now();
        if (now >= deadline) return false;
        if (onTick && now >= nextTick) {
            onTick(inflight);
            nextTick = now + tickEveryMs;
        }
        await new Promise(r => setTimeout(r, Math.min(pollMs, deadline - now)));
    }
    return true;
}

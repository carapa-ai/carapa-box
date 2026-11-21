import { timingSafeEqual } from "node:crypto";

export function bearerToken(headers: Headers): string | null {
    const value = headers.get("Authorization");
    return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export function safeTokenCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

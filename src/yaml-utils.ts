import { parse } from "yaml";

/**
 * YAML list reader: returns the string items of the top-level list under `key`.
 *
 * Uses the `yaml` package. Invalid YAML throws (fail closed): every caller
 * treats a thrown error as an empty/denied policy.
 */
export function parseYamlList(content: string, key: string): string[] {
    return yamlStringList(parse(content), key);
}

/** The string items of the top-level list under `key` in an already parsed YAML document. */
export function yamlStringList(doc: unknown, key: string): string[] {
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
    const list = (doc as Record<string, unknown>)[key];
    if (!Array.isArray(list)) return [];
    const values: string[] = [];
    for (const item of list) {
        let val: string | undefined;
        if (typeof item === "string") val = item.trim();
        else if (typeof item === "number" && Number.isFinite(item)) val = String(item);
        if (val) values.push(val);
    }
    return values;
}

/**
 * Models an ACP harness offers, from its initialize reply (Grok Build) and its
 * session/new, session/load or session/resume reply. Board reads the saved
 * list to discover models for a harness without a separate account lookup.
 */
export type HarnessModel = { id: string; name?: string; contextSize?: number; reasoning?: string[]; defaultReasoning?: string };

type Json = Record<string, any>;
const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;

// Grok Build puts per-model limits and reasoning efforts in _meta.modelState.
function grokModel(value: Json): HarnessModel | undefined {
  const id = text(value?.modelId);
  if (!id) return undefined;
  const efforts: Json[] = Array.isArray(value._meta?.reasoningEfforts) ? value._meta.reasoningEfforts : [];
  const context = Number(value._meta?.totalContextTokens);
  return {
    id,
    ...(text(value.name) ? { name: value.name } : {}),
    ...(Number.isInteger(context) && context > 0 ? { contextSize: context } : {}),
    ...(efforts.length ? { reasoning: efforts.map(e => e?.value).filter(text) } : {}),
    ...(text(efforts.find(e => e?.default)?.value) ? { defaultReasoning: efforts.find(e => e?.default)!.value } : {}),
  };
}

/** Earlier replies win for a model reported twice; pass the most detailed first. */
export function availableModels(...results: Array<Json | undefined>): HarnessModel[] {
  const models = new Map<string, HarnessModel>();
  const add = (model: HarnessModel | undefined) => { if (model && !models.has(model.id)) models.set(model.id, model); };
  for (const result of results) {
    for (const value of result?._meta?.modelState?.availableModels ?? []) add(grokModel(value));
    // The ACP session model list, used by Antigravity and Hermes.
    for (const value of result?.models?.availableModels ?? []) {
      if (text(value?.modelId)) add({ id: value.modelId, ...(text(value.name) ? { name: value.name } : {}) });
    }
    // Session config options, used by Muse.
    for (const option of Array.isArray(result?.configOptions) ? result.configOptions : []) {
      if (option?.id !== 'model' && option?.category !== 'model') continue;
      for (const value of option.options ?? []) {
        if (text(value?.value)) add({ id: value.value, ...(text(value.name) ? { name: value.name } : {}) });
      }
    }
  }
  return [...models.values()];
}

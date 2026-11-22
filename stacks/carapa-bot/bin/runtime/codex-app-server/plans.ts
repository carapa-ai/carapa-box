import { hostPath } from '../roots';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CodexRunnerArgs } from './types';
import { string } from './types';

export type PlanRenderer = (id: string, text: string) => string;

/** One saved artifact per completed plan item, however often it is rendered. */
export function createPlanRenderer(args: CodexRunnerArgs): PlanRenderer {
  const rendered = new Map<string, string>();
  return (id, text) => {
    const existing = rendered.get(id);
    if (existing !== undefined) return existing;
    const content = planDisplayText(args, text);
    rendered.set(id, content);
    return content;
  };
}

function metadata(text: string): { title: string; relativePath: string; artifactPath: string } {
  const heading = text.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1]?.trim();
  const title = heading || 'Implementation plan';
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'implementation-plan';
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const relativePath = `plans/${timestamp}-${slug}.md`;
  return { title, relativePath, artifactPath: `artifacts/${relativePath}` };
}

export function planDisplayText(args: CodexRunnerArgs, text: string): string {
  const plan = metadata(text);
  if (text) {
    const groupDir = string(args.groupDir, hostPath('/workspace/group'));
    const target = join(groupDir, 'artifacts', plan.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
    writeFileSync(`${target}.meta.json`, JSON.stringify({ source: 'agent' }));
  }
  return `${text}\n\n\`\`\`carapaplan\n${JSON.stringify({
    artifactPath: plan.artifactPath,
    planTitle: plan.title,
    planText: text,
  })}\n\`\`\`\n`;
}

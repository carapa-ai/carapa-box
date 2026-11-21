#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Container-local view of the shared agent home. The compose file mounts the
 * shared home read-only at `shared` and an empty container-local directory
 * over `~/.agent/skills` and `~/.agent/rules`; every harness skill and rule
 * path resolves to those two directories. A refresh links, in order (a later
 * layer replaces an earlier entry with the same name):
 *   platform        <shared>/.agent/{skills,rules}
 *   stack           <stack>/{skills,rules} (mounted read-only by the stack, if any)
 *   group template  <shared>/.agent/scopes/group/{skills,rules} (CarapaBrain only)
 *   project         <group>/.agent/{skills,rules}
 * minus the project's disabled skills. In a CarapaBrain container, objective
 * template entries are linked into each objective's own .agent/{skills,rules},
 * never over a real local file.
 */
export const VIEW_MARKER = '.carapa-agent-view';

export interface AgentViewPaths {
  home: string;
  shared: string;
  /** Stack-provided skills and rules (`<stack>/{skills,rules}`); absent folders are skipped. */
  stack: string;
  group: string;
  /** The container runs CarapaBrain: link its group and objective templates. */
  brain: boolean;
}

export interface AgentViewReport {
  skills: string[];
  rules: string[];
  skipped: string[];
  objectives: number;
}

type MountCheck = (directory: string, home: string) => boolean;

/** A container-local mount has its own device; the shared home never does. */
export function isSeparateMount(directory: string, home: string): boolean {
  try {
    return statSync(directory).dev !== statSync(home).dev;
  } catch {
    return false;
  }
}

/** CarapaBrain images install the app at /app; plain CarapaBot images have none. */
export function brainInstalled(app = '/app'): boolean {
  try {
    return (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { name?: unknown }).name === 'carapa-brain';
  } catch {
    return false;
  }
}

export function agentViewActive(home: string): boolean {
  return existsSync(join(home, '.agent', 'rules', VIEW_MARKER));
}

/** A file that cannot be read or parsed disables nothing: every skill and rule stays linked. */
function disabledSkills(group: string): { names: Set<string>; warning?: string } {
  const path = join(group, '.carapa', 'disabled-skills.json');
  if (!existsSync(path)) return { names: new Set() };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { disabledSkills?: unknown } | null;
    const list = Array.isArray(parsed?.disabledSkills) ? parsed.disabledSkills : [];
    return { names: new Set(list.filter((name): name is string => typeof name === 'string')) };
  } catch (error) {
    return { names: new Set(), warning: `${path} ignored, no skill disabled: ${(error as Error).message}` };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Skill folders (with SKILL.md) or .md rule files of one layer, by name. */
function layerEntries(directory: string, kind: 'skills' | 'rules'): Map<string, string> {
  const entries = new Map<string, string>();
  if (!isDirectory(directory)) return entries;
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(directory, name);
    if (kind === 'skills' ? existsSync(join(path, 'SKILL.md')) : name.endsWith('.md') && !isDirectory(path)) {
      entries.set(name, path);
    }
  }
  return entries;
}

function merged(layers: string[], kind: 'skills' | 'rules', disabled: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const layer of layers) {
    for (const [name, path] of layerEntries(layer, kind)) result.set(name, path);
  }
  if (kind === 'skills') for (const name of disabled) result.delete(name);
  return result;
}

function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `directory` hold exactly the `desired` links among the links it owns.
 * `owned` decides which existing links this refresh may remove; real files and
 * folders are never touched.
 */
function syncLinks(directory: string, desired: Map<string, string>, owned: (target: string) => boolean): void {
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const target = linkTarget(path);
    if (target === null || !owned(target)) continue;
    if (desired.get(name) !== target) rmSync(path);
  }
  for (const [name, target] of desired) {
    const path = join(directory, name);
    if (!exists(path)) symlinkSync(target, path);
  }
}

const GITIGNORE_HEADER = '# Generated by carapa-agent-view: links to shared templates, not tracked.';

/**
 * Keep the links this refresh owns out of Git while real local files stay
 * tracked. Writes through a symlinked directory into the real one, so the
 * patterns apply where the links actually live. A hand-written .gitignore is
 * never replaced.
 */
function syncGitignore(directory: string, owned: (target: string) => boolean): void {
  const path = join(directory, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing !== null && !existing.startsWith(GITIGNORE_HEADER)) return;
  const names = readdirSync(directory)
    .filter((name) => {
      const target = linkTarget(join(directory, name));
      return target !== null && owned(target);
    })
    .sort();
  if (names.length === 0) {
    if (existing !== null) rmSync(path);
    return;
  }
  const content = [GITIGNORE_HEADER, '/.gitignore', ...names.map((name) => `/${name}`), ''].join('\n');
  if (content !== existing) writeFileSync(path, content);
}

export function refreshAgentView(paths: AgentViewPaths, mounted: MountCheck = isSeparateMount): AgentViewReport {
  const home = resolve(paths.home);
  const shared = resolve(paths.shared);
  const group = resolve(paths.group);
  const report: AgentViewReport = { skills: [], rules: [], skipped: [], objectives: 0 };
  if (!isDirectory(join(shared, '.agent'))) {
    report.skipped.push(`no shared agent home at ${shared}`);
    return report;
  }
  const { names: disabled, warning } = disabledSkills(group);
  for (const kind of ['skills', 'rules'] as const) {
    const view = join(home, '.agent', kind);
    if (!mounted(view, home)) {
      // Writing here would change the agent home of every sandbox.
      report.skipped.push(`${view} is not a container-local mount`);
      continue;
    }
    const layers = [join(shared, '.agent', kind), join(resolve(paths.stack), kind), join(group, '.agent', kind)];
    if (paths.brain) layers.splice(2, 0, join(shared, '.agent', 'scopes', 'group', kind));
    const desired = merged(layers, kind, disabled);
    syncLinks(view, desired, () => true);
    report[kind] = [...desired.keys()].sort();
  }
  if (report.skipped.length === 0) writeFileSync(join(home, '.agent', 'rules', VIEW_MARKER), '');
  // After the marker: the view is complete, the file is only reported.
  if (warning) report.skipped.push(warning);

  const objectives = join(group, 'objectives');
  if (!paths.brain || !isDirectory(objectives)) return report;
  const templateRoot = join(shared, '.agent', 'scopes', 'objective');
  for (const name of readdirSync(objectives).sort()) {
    const agentDir = join(objectives, name, '.agent');
    if (!isDirectory(agentDir) || linkTarget(agentDir) !== null) continue;
    for (const kind of ['skills', 'rules'] as const) {
      const templates = join(templateRoot, kind);
      const owned = (target: string) => target.startsWith(`${templates}/`);
      syncLinks(join(agentDir, kind), merged([templates], kind, disabled), owned);
      syncGitignore(join(agentDir, kind), owned);
    }
    report.objectives += 1;
  }
  return report;
}

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command !== 'refresh') {
    console.error('Usage: carapa-agent-view refresh');
    process.exit(2);
  }
  const report = refreshAgentView({
    home: process.env.HOME || '/home/ubuntu',
    shared: process.env.CARAPA_AGENT_SHARED || '/opt/carapa/agent-home',
    stack: process.env.CARAPA_AGENT_STACK || '/opt/carapa/stack-agent',
    group: process.env.CARAPA_GROUP_ROOT || '/workspace/group',
    brain: brainInstalled(),
  });
  for (const reason of report.skipped) console.error(`carapa-agent-view: skipped: ${reason}`);
  console.log(
    `carapa-agent-view: ${report.skills.length} skills, ${report.rules.length} rules, ${report.objectives} objectives`,
  );
}

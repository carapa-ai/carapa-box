import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIEW_MARKER, agentViewActive, refreshAgentView } from './agent-view';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function skill(directory: string, name: string): string {
  mkdirSync(join(directory, name), { recursive: true });
  writeFileSync(join(directory, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  return join(directory, name);
}

function rule(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), '---\ntrigger: always_on\n---\nbody\n');
  return join(directory, name);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carapa-agent-view-'));
  roots.push(root);
  const paths = { home: join(root, 'home'), shared: join(root, 'shared'), stack: join(root, 'stack'), group: join(root, 'group'), brain: true };
  mkdirSync(join(paths.home, '.agent', 'skills'), { recursive: true });
  mkdirSync(join(paths.home, '.agent', 'rules'), { recursive: true });
  return paths;
}

describe('container agent view', () => {
  test('never writes into a view directory that is not a container-local mount', () => {
    const paths = fixture();
    skill(join(paths.shared, '.agent', 'skills'), 'platform');
    writeFileSync(join(paths.home, '.agent', 'skills', 'keep.txt'), 'x');

    const report = refreshAgentView(paths, () => false);

    expect(report.skipped).toHaveLength(2);
    expect(readdirSync(join(paths.home, '.agent', 'skills'))).toEqual(['keep.txt']);
    expect(agentViewActive(paths.home)).toBe(false);
  });

  test('links layers in order, drops disabled skills and stale links', () => {
    const paths = fixture();
    const skills = join(paths.home, '.agent', 'skills');
    skill(join(paths.shared, '.agent', 'skills'), 'shared-only');
    skill(join(paths.shared, '.agent', 'skills'), 'overridden');
    skill(join(paths.shared, '.agent', 'skills'), 'unwanted');
    skill(join(paths.shared, '.agent', 'scopes', 'group', 'skills'), 'group-template');
    const projectCopy = skill(join(paths.group, '.agent', 'skills'), 'overridden');
    rule(join(paths.shared, '.agent', 'rules'), 'platform.md');
    const projectRule = rule(join(paths.group, '.agent', 'rules'), 'platform.md');
    mkdirSync(join(paths.group, '.carapa'), { recursive: true });
    writeFileSync(join(paths.group, '.carapa', 'disabled-skills.json'), JSON.stringify({ disabledSkills: ['unwanted'] }));
    symlinkSync('/gone', join(skills, 'removed-skill'));

    const report = refreshAgentView(paths, () => true);

    expect(report.skills).toEqual(['group-template', 'overridden', 'shared-only']);
    expect(readlinkSync(join(skills, 'overridden'))).toBe(projectCopy);
    expect(existsSync(join(skills, 'unwanted'))).toBe(false);
    expect(existsSync(join(skills, 'removed-skill'))).toBe(false);
    expect(readlinkSync(join(paths.home, '.agent', 'rules', 'platform.md'))).toBe(projectRule);
    expect(existsSync(join(paths.home, '.agent', 'rules', VIEW_MARKER))).toBe(true);
  });

  test('links stack rules between platform and project layers', () => {
    const paths = fixture();
    rule(join(paths.shared, '.agent', 'rules'), 'sandbox.md');
    const stackRule = rule(join(paths.stack, 'rules'), 'sandbox.md');
    const stackSkill = skill(join(paths.stack, 'skills'), 'stack-tool');
    const projectRule = rule(join(paths.group, '.agent', 'rules'), 'project.md');

    refreshAgentView(paths, () => true);

    expect(readlinkSync(join(paths.home, '.agent', 'rules', 'sandbox.md'))).toBe(stackRule);
    expect(readlinkSync(join(paths.home, '.agent', 'skills', 'stack-tool'))).toBe(stackSkill);
    expect(readlinkSync(join(paths.home, '.agent', 'rules', 'project.md'))).toBe(projectRule);
  });

  test('a container without CarapaBrain gets neither the group template nor objective links', () => {
    const paths = { ...fixture(), brain: false };
    skill(join(paths.shared, '.agent', 'skills'), 'shared-only');
    skill(join(paths.shared, '.agent', 'scopes', 'group', 'skills'), 'group-template');
    rule(join(paths.shared, '.agent', 'scopes', 'group', 'rules'), 'identity.md');
    skill(join(paths.shared, '.agent', 'scopes', 'objective', 'skills'), 'assess-progress');
    const objective = join(paths.group, 'objectives', 'obj-1', '.agent');
    mkdirSync(join(objective, 'skills'), { recursive: true });

    const report = refreshAgentView(paths, () => true);

    expect(report.skills).toEqual(['shared-only']);
    expect(report.rules).toEqual([]);
    expect(report.objectives).toBe(0);
    expect(readdirSync(join(objective, 'skills'))).toEqual([]);
  });

  test('links objective templates without replacing local files or foreign links', () => {
    const paths = fixture();
    const templates = join(paths.shared, '.agent', 'scopes', 'objective');
    const assess = skill(join(templates, 'skills'), 'assess-progress');
    skill(join(templates, 'skills'), 'decision-loop');
    rule(join(templates, 'rules'), 'identity.md');
    const objective = join(paths.group, 'objectives', 'obj-1', '.agent');
    const localIdentity = rule(join(objective, 'rules'), 'identity.md');
    mkdirSync(join(objective, 'skills'), { recursive: true });
    symlinkSync(join(templates, 'skills', 'retired'), join(objective, 'skills', 'retired'));
    symlinkSync('/elsewhere/mine', join(objective, 'skills', 'mine'));
    mkdirSync(join(paths.group, '.carapa'), { recursive: true });
    writeFileSync(join(paths.group, '.carapa', 'disabled-skills.json'), JSON.stringify({ disabledSkills: ['decision-loop'] }));

    const report = refreshAgentView(paths, () => true);

    expect(report.objectives).toBe(1);
    expect(readlinkSync(join(objective, 'skills', 'assess-progress'))).toBe(assess);
    expect(existsSync(join(objective, 'skills', 'decision-loop'))).toBe(false);
    expect(existsSync(join(objective, 'skills', 'retired'))).toBe(false);
    expect(readlinkSync(join(objective, 'skills', 'mine'))).toBe('/elsewhere/mine');
    expect(lstatSync(localIdentity).isSymbolicLink()).toBe(false);
  });

  test('links every skill and rule, and reports a warning, when disabled-skills.json is malformed', () => {
    const paths = fixture();
    const shared = join(paths.shared, '.agent');
    skill(join(shared, 'skills'), 'platform');
    rule(join(shared, 'rules'), 'safety.md');
    mkdirSync(join(paths.group, '.carapa'), { recursive: true });
    writeFileSync(join(paths.group, '.carapa', 'disabled-skills.json'), '{"disabledSkills": [');

    const report = refreshAgentView(paths, () => true);

    expect(report.skills).toEqual(['platform']);
    expect(report.rules).toEqual(['safety.md']);
    expect(existsSync(join(paths.home, '.agent', 'skills', 'platform'))).toBe(true);
    expect(existsSync(join(paths.home, '.agent', 'rules', 'safety.md'))).toBe(true);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('disabled-skills.json');
    expect(agentViewActive(paths.home)).toBe(true);
  });

  test('keeps template links out of Git but never a real local file or a hand-written .gitignore', () => {
    const paths = fixture();
    const templates = join(paths.shared, '.agent', 'scopes', 'objective');
    skill(join(templates, 'skills'), 'assess-progress');
    rule(join(templates, 'rules'), 'identity.md');
    rule(join(templates, 'rules'), 'agent-behavior.md');
    const objective = join(paths.group, 'objectives', 'obj-1', '.agent');
    rule(join(objective, 'rules'), 'identity.md');
    mkdirSync(join(objective, 'skills'), { recursive: true });
    writeFileSync(join(objective, 'skills', '.gitignore'), 'mine\n');

    refreshAgentView(paths, () => true);

    const ignore = readFileSync(join(objective, 'rules', '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('/agent-behavior.md');
    expect(ignore).toContain('/.gitignore');
    expect(ignore).not.toContain('/identity.md');
    expect(readFileSync(join(objective, 'skills', '.gitignore'), 'utf8')).toBe('mine\n');
  });
});

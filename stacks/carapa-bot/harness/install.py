#!/usr/bin/env python3
"""Explicit, unprivileged installation into a new harness volume. Never startup."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(os.environ.get('CARAPA_HARNESS_ROOT', '/opt/carapa-harness'))
ABI = ROOT / 'runtime-abi.json' if (ROOT / 'runtime-abi.json').exists() else Path('/usr/local/share/carapa/harness-abi.json')
PYTHON = str(ROOT / 'python/bin/python3') if (ROOT / 'python/bin/python3').exists() else 'python3'
PACKAGES = {
    'codex': '@openai/codex', 'claude': '@anthropic-ai/claude-code',
    'pi': '@earendil-works/pi-coding-agent', 'omp': '@oh-my-pi/pi-coding-agent',
    'playwright': '@playwright/cli',
    # xAI Grok Build; glibc-only native binary, ACP via `grok agent stdio`.
    'grok': '@xai-official/grok',
}
NAMES = (*PACKAGES, 'opencode', 'cursor', 'prime-agent', 'hermes',
         'antigravity', 'antigravity-acp', 'muse', 'vibe')
# Mistral Vibe (mistral-vibe on PyPI): glibc-only native wheel, ACP via `vibe-acp`.
PINNED = {'playwright': '0.1.24', 'grok': '1.0.52', 'vibe': '3.1.0'}
# Community ACP bridge for Muse Code (Apache-2.0); adapter-tested at this version.
MUSE_ACP_VERSION = '0.13.1'


def run(*args, env=None, capture=False):
    return subprocess.run(args, check=True, text=True, env={**os.environ, **(env or {})},
                          stdout=subprocess.PIPE if capture else None).stdout


def parse_spec(spec):
    name, _, version = spec.partition('@')
    if name not in NAMES or (version and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_-]*', version)):
        raise ValueError('Unknown harness or invalid version: ' + spec)
    version = version or PINNED.get(name, 'latest')
    if name in PINNED and version != PINNED[name]:
        raise ValueError(f'{name} is adapter-tested at {PINNED[name]}; update the installer to change it')
    if name in ('cursor', 'prime-agent', 'muse') and version != 'latest':
        raise ValueError(f'{name} uses the upstream installer; only latest is supported')
    return name, version


def npm(directory, package, version):
    run('npm', 'install', '--global', '--prefix', str(directory), '--no-fund', '--no-audit',
        '--allow-scripts=' + package + ',@google/genai,koffi,protobufjs',
        package + '@' + version)
    return json.loads((directory / 'lib/node_modules' / package / 'package.json').read_text())['version']


def python_env(directory, package, version):
    run(PYTHON, '-m', 'venv', str(directory / 'venv'))
    pip = str(directory / 'venv/bin/pip')
    run(pip, 'install', '--no-cache-dir', package + ('' if version == 'latest' else '==' + version))
    distribution = package.split('[')[0]
    resolved = run(str(directory / 'venv/bin/python'), '-c',
                   'import importlib.metadata,sys; print(importlib.metadata.version(sys.argv[1]))',
                   distribution, capture=True).strip()
    return pip, resolved


def antigravity_release(version):
    """Resolve an Antigravity CLI release and the SHA-256 GitHub publishes for its archive."""
    arch = {'x86_64': 'linux_x64', 'aarch64': 'linux_arm64'}[os.uname().machine]
    release = 'latest' if version == 'latest' else 'tags/' + version
    data = json.loads(run('curl', '-fsSL', '--proto', '=https', '--tlsv1.2',
                          f'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/{release}', capture=True))
    digest = next((a.get('digest') or '' for a in data['assets'] if a['name'] == f'agy_cli_{arch}.tar.gz'), '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise RuntimeError('Antigravity release has no published SHA-256 for ' + arch)
    return data['tag_name'], digest.removeprefix('sha256:')


def opencode_asset(machine, libc):
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[machine]
    return f'opencode-linux-{arch}' + ('-musl' if libc == 'musl' else '') + '.tar.gz'


def install(root, name, version):
    directory = root / 'harnesses' / name
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True)
    bins = directory / 'bin'
    bins.mkdir()
    commands = []
    if name in PACKAGES:
        if name == 'omp':
            run('bun', 'install', '-g', PACKAGES[name] + '@' + version, env={
                'BUN_INSTALL_GLOBAL_DIR': str(directory / 'bun/global'),
                'BUN_INSTALL_BIN': str(bins)})
            resolved = json.loads((directory / 'bun/global/node_modules' / PACKAGES[name] / 'package.json').read_text())['version']
            npm(directory, 'typescript', '7.0.2')
            npm(directory, '@zed-industries/vscode-langservers-extracted', '4.10.8')
        else:
            resolved = npm(directory, PACKAGES[name], version)
        if name == 'pi':
            # Runtime extension lives in the volume, never in the disposable installer HOME.
            npm(directory, 'pi-mcp-adapter', 'latest')
        if name == 'playwright':
            # Upstream's downloadable FFmpeg is glibc-based. Use Alpine's
            # encoder at the path expected by this exact Playwright version.
            module = directory / 'lib/node_modules/@playwright/cli/package.json'
            executable = Path(run('node', '-e',
                'const req=require("node:module").createRequire(process.argv[1]); '
                'console.log(req("playwright-core/lib/coreBundle").registry.registry.findExecutable("ffmpeg").executablePath())',
                str(module), capture=True).strip())
            if not executable.is_relative_to(directory / 'browsers'):
                raise RuntimeError('Playwright browser cache must be inside its harness volume')
            if json.loads(ABI.read_text())['libc'][0] == 'musl':
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.symlink_to('/usr/bin/ffmpeg')
            else:
                # Recording must work from a read-only release with an empty
                # agent home; install the matching encoder before publication.
                core_cli = run('node', '-e',
                    'const req=require("node:module").createRequire(process.argv[1]); '
                    'console.log(require("node:path").join(require("node:path").dirname('
                    'req.resolve("playwright-core/package.json")), "cli.js"))', str(module), capture=True).strip()
                run('node', core_cli, 'install', 'ffmpeg')
        commands = [p.name for p in bins.iterdir()]
    elif name == 'opencode':
        libc = json.loads(ABI.read_text())['libc'][0]
        asset = opencode_asset(os.uname().machine, libc)
        release = 'latest' if version == 'latest' else 'tags/v' + version.removeprefix('v')
        data = json.loads(run('curl', '-fsSL', f'https://api.github.com/repos/anomalyco/opencode/releases/{release}', capture=True))
        resolved = data['tag_name']
        url = f'https://github.com/anomalyco/opencode/releases/download/{resolved}/{asset}'
        with tempfile.TemporaryDirectory() as tmp:
            archive = str(Path(tmp) / 'opencode.tar.gz')
            run('curl', '-fsSL', url, '-o', archive)
            run('tar', '-xzf', archive, '-C', str(bins), 'opencode')
        commands = ['opencode']
    elif name in ('hermes', 'antigravity', 'vibe'):
        package = {'hermes': 'hermes-agent[acp]', 'antigravity': 'google-antigravity', 'vibe': 'mistral-vibe'}[name]
        pip, resolved = python_env(directory, package, version)
        if name == 'hermes':
            run(pip, 'install', '--no-cache-dir', 'pillow==12.3.0')
        commands = {'hermes': ['hermes', 'hermes-agent', 'hermes-acp'], 'vibe': ['vibe', 'vibe-acp']}.get(name, [])
        for command in commands:
            (bins / command).symlink_to(directory / 'venv/bin' / command)
    elif name == 'muse':
        payload = directory / 'muse'
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'install.sh'
            run('curl', '-fsSL', 'https://dev.meta.ai/install.sh', '-o', str(script))
            run('/bin/bash', str(script), env={'HOME': tmp, 'MUSE_INSTALL_DIR': str(payload),
                'MUSE_NO_MODIFY_PATH': '1', 'MUSE_UPGRADE_MODE': '1', 'MUSE_LOGIN': '0'})
        muse_version = (payload / '.muse-version').read_text().strip()
        # Link the versioned binary, not the self-updating launcher: releases are read-only.
        (bins / 'muse').symlink_to(payload / ('muse-bin-' + muse_version))
        bridge_version = npm(directory, '@brokkai/muse-acp', MUSE_ACP_VERSION)
        commands = ['muse', 'muse-acp']
        resolved = f'{muse_version}+muse-acp.{bridge_version}'
    elif name == 'antigravity-acp':
        resolved, sha = antigravity_release(version)
        run('/bin/sh', '/usr/local/lib/carapa-harness/install-antigravity-acp.sh',
            env={'ANTIGRAVITY_ACP_DESTINATION': str(directory / 'payload'),
                 'ANTIGRAVITY_ACP_VERSION': resolved, 'ANTIGRAVITY_ACP_SHA256': sha})
        # The same program is Google's interactive Antigravity CLI: expose it as `agy`.
        (bins / 'agy').symlink_to('../payload/antigravity')
        commands = ['agy']
    else:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            url = ('https://cursor.com/install' if name == 'cursor' else
                   'https://app.primeintellect.ai/prime-agent/install.sh')
            script = home / 'install.sh'
            run('curl', '-fsSL', url, '-o', str(script))
            # Prime's installer unpacks under its prefix and tests the payload
            # with `[ -x ]`, which fails on the noexec /tmp home: install into
            # the release directory instead (launcher in bin/, payload in share/).
            run('/bin/bash', str(script), env={'HOME': tmp, 'NPM_CONFIG_PREFIX': str(directory),
                'NPM_CONFIG_ALLOW_REMOTE': 'all', 'PRIME_AGENT_INSTALLER_PLAIN': '1',
                'PRIME_AGENT_RUST_PREFIX': str(directory), 'PRIME_AGENT_UV_BIN_DIR': str(directory / 'uv'),
                'PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL': '0'})
            if name == 'cursor':
                payload = home / '.local/share/cursor-agent'
                shutil.move(str(payload), str(directory / 'cursor'))
                versions = sorted((directory / 'cursor/versions').iterdir())
                if len(versions) != 1:
                    raise RuntimeError('Cursor installer did not produce exactly one version')
                selected = versions[0]
                # Keep the compatibility fix used by the previous image build.
                # The archive name is fixed by this pin; npm's JSON output
                # changed shape in npm 12 and is not needed here.
                run('npm', 'pack', '--ignore-scripts', '--pack-destination', tmp,
                    'piscina@4.9.3')
                piscina = selected / 'node_modules/piscina'
                shutil.rmtree(piscina, ignore_errors=True)
                piscina.mkdir(parents=True)
                run('tar', '-xzf', str(home / 'piscina-4.9.3.tgz'), '--strip-components=1', '-C', str(piscina))
                (bins / 'cursor-agent').symlink_to(selected / 'cursor-agent')
                (bins / 'agent').symlink_to(bins / 'cursor-agent')
                commands = ['cursor-agent', 'agent']
                resolved = selected.name
            else:
                commands = ['prime-agent']
                # The launcher finds its payload via "$(dirname "$0")/..", but the
                # public command is a symlink in another directory: pin the path.
                launcher = bins / 'prime-agent'
                text = launcher.read_text()
                if '$(dirname "$0")/..' not in text:
                    raise RuntimeError('Unexpected Prime launcher layout')
                launcher.write_text(text.replace('$(dirname "$0")/..', str(directory)))
                resolved = run(str(launcher), '--version', capture=True).strip()
                projects = list(directory.glob('share/prime-agent/prime-agent-runtime/pyproject.toml'))
                if len(projects) != 1:
                    raise RuntimeError('Prime release is missing its matching Python runtime')
                run(PYTHON, '-m', 'venv', str(directory / 'venv'))
                run(str(directory / 'venv/bin/pip'), 'install', '--no-cache-dir',
                    str(projects[0].parent), 'dill', 'requests', 'httpx', 'pyyaml', 'tomli',
                    'python-dotenv', 'pandas', 'numpy', 'scipy', 'beautifulsoup4', 'lxml', 'pydantic', 'ipykernel')
    return {'requested': version, 'version': resolved, 'commands': commands}


def link_commands(root, harnesses):
    shutil.rmtree(root / 'bin', ignore_errors=True)
    (root / 'bin').mkdir()
    for name, entry in harnesses.items():
        for command in entry['commands']:
            if not re.fullmatch(r'[A-Za-z0-9_.+-]+', command):
                raise ValueError('Invalid harness command')
            (root / 'bin' / command).symlink_to(root / 'harnesses' / name / 'bin' / command)
    for alias, target in {'venv': 'harnesses/antigravity/venv',
                          'antigravity-acp': 'harnesses/antigravity-acp/payload'}.items():
        (root / alias).unlink(missing_ok=True)
        (root / alias).symlink_to(target)


def main():
    specs = dict(parse_spec(spec) for spec in sys.argv[1:])
    if 'playwright' in specs:
        os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(ROOT / 'harnesses/playwright/browsers')
    manifest = ROOT / 'manifest.json'
    data = json.loads(manifest.read_text()) if manifest.exists() else {'harnesses': {}}
    for name, version in specs.items():
        data['harnesses'][name] = install(ROOT, name, version)
    link_commands(ROOT, data['harnesses'])
    data['abi'] = json.loads(ABI.read_text())
    # Freeze resolved package inventories for audit/debugging (not credentials).
    data['inventories'] = {}
    for name in data['harnesses']:
        directory = ROOT / 'harnesses' / name
        if (directory / 'venv/bin/pip').exists():
            data['inventories'][name] = run(str(directory / 'venv/bin/pip'), 'freeze', capture=True).splitlines()
    manifest.write_text(json.dumps(data, indent=2) + '\n')


if __name__ == '__main__':
    main()

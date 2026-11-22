#!/usr/bin/env python3
"""Validate installed payload offline, as the runtime user on a read-only mount."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(os.environ.get('CARAPA_HARNESS_ROOT', '/opt/carapa-harness'))


def verify(root=ROOT, abi_file=None):
    if abi_file is None:
        abi_file = root / 'runtime-abi.json' if (root / 'runtime-abi.json').exists() else Path('/usr/local/share/carapa/harness-abi.json')
    data = json.loads((root / 'manifest.json').read_text())
    if data['abi'] != json.loads(abi_file.read_text()):
        raise RuntimeError('Harness/runtime ABI mismatch; install --replace using the selected image')
    for name, entry in data['harnesses'].items():
        for command in entry['commands']:
            target = root / 'bin' / command
            if not target.resolve().is_relative_to(root.resolve()) or not os.access(target, os.X_OK):
                raise RuntimeError('Missing or escaping harness executable: ' + str(target))
        directory = root / 'harnesses' / name
        modules = {'hermes': ['hermes_cli', 'acp'], 'antigravity': ['google.antigravity'],
                   'prime-agent': ['rlm', 'ipykernel']}.get(name)
        if modules:
            subprocess.run([str(directory / 'venv/bin/python'), '-c',
                'import importlib,sys; [importlib.import_module(m) for m in sys.argv[1:]]', *modules], check=True, timeout=60)
        if name in ('codex', 'claude', 'grok', 'muse', 'pi', 'omp', 'opencode', 'prime-agent', 'vibe', 'playwright'):
            command = {'playwright': 'playwright-cli'}.get(name, name)
            executable = (Path('/usr/local/ai-cli-bin/playwright-cli') if name == 'playwright'
                          else root / 'bin' / command)
            subprocess.run([str(executable), '--version'], check=True, timeout=60,
                env={**os.environ, 'CARAPA_PLAYWRIGHT_REAL': str(root / 'bin/playwright-cli'),
                     'PLAYWRIGHT_BROWSERS_PATH': str(root / 'harnesses/playwright/browsers')})
        if name == 'antigravity-acp':
            if not os.access(directory / 'payload/antigravity', os.X_OK):
                raise RuntimeError('Missing Antigravity ACP payload: antigravity')
    return data


if __name__ == '__main__':
    store = Path('/opt/carapa-harness-store')
    if 'CARAPA_HARNESS_ROOT' not in os.environ and (store / 'current').exists():
        data = json.loads((store / 'snapshots' / ((os.environ.get('CARAPA_HARNESS_SNAPSHOT') or (store / 'current').read_text().strip()) + '.json')).read_text())
        if data['abi'] != json.loads(Path('/usr/local/share/carapa/harness-abi.json').read_text()):
            raise RuntimeError('Harness/runtime ABI mismatch')
        for release in {e['release'] for e in data['entries'].values()}:
            verify(store / 'releases' / release)
        ROOT = store
    else:
        verify()
    try:
        (ROOT / '.write-test').touch()
    except PermissionError:
        pass
    except OSError as error:
        if error.errno != 30:  # EROFS
            raise
    else:
        raise RuntimeError('Harness mount must be read-only')

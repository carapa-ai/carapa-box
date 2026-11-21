#!/usr/bin/env python3
"""Read-only runtime dispatcher. A boot lease also covers detached descendants."""
import json
import os
from pathlib import Path
import re
import sys
import uuid

STORE = Path(os.environ.get('CARAPA_HARNESS_STORE', '/opt/carapa-harness-store'))
LEASES = Path('/tmp/carapa-harness-leases')
PIN = 'CARAPA_HARNESS_SNAPSHOT'
VALID = re.compile(r'[0-9a-f]{32}')


def boot_id():
    # PID 1's start time is stable for this container boot (including gVisor).
    return Path('/proc/1/stat').read_text().rsplit(')', 1)[1].split()[19]


def snapshot():
    identity = (STORE / 'identity').read_text().strip()
    directory = LEASES / identity / boot_id()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Publish intent BEFORE reading the selection. Cleanup treats pending
    # intent as a reason to retain everything. Leases last for this boot,
    # so daemonization/fork/exec and process-enumeration races cannot lose pins.
    pending = directory / ('pending-' + uuid.uuid4().hex)
    pending.touch(mode=0o600)
    try:
        selected = os.environ.get(PIN) or (STORE / 'current').read_text().strip()
        if not VALID.fullmatch(selected):
            raise RuntimeError('Invalid harness snapshot')
        data = json.loads((STORE / 'snapshots' / (selected + '.json')).read_text())
        pending.replace(directory / selected)
    except BaseException:
        # A failed or interrupted launch must not leave intent that blocks cleanup.
        pending.unlink(missing_ok=True)
        raise
    return selected, data


def main():
    selected, data = snapshot()
    env = dict(os.environ)
    browser_override = env.get('CARAPA_PLAYWRIGHT_REAL')
    for entry in data['entries'].values():
        env.update(entry.get('env', {}))
    if browser_override and not browser_override.startswith(str(STORE) + '/'):
        env['CARAPA_PLAYWRIGHT_REAL'] = browser_override
    # Preserve the old default harness Python position, while leaving an
    # image-owned CUDA/project venv in control when one exists.
    if env.get('CARAPA_HARNESS_PYTHON_BIN') and not Path('/opt/carapa-harness/venv/bin/python').exists():
        env['PATH'] = ':'.join(env['CARAPA_HARNESS_PYTHON_BIN'] if p == '/opt/carapa-harness/venv/bin' else p
                               for p in env.get('PATH', '/usr/bin:/bin').split(':'))
    env[PIN] = selected
    env['CARAPA_HARNESS_STORE'] = str(STORE)
    command = Path(sys.argv[0]).name
    if command in ('launch.py', 'carapa-harness-exec'):
        arguments = sys.argv[1:]
        if not arguments:
            raise RuntimeError('carapa-harness-exec requires a command')
    else:
        matches = [str(STORE / 'releases' / e['release'] / e['commands'][command])
                   for e in data['entries'].values() if command in e.get('commands', {})]
        if len(matches) != 1:
            raise RuntimeError('Harness command is not installed: ' + command)
        # Node 16 project images carry a separate modern Node for harnesses.
        # Keep project PATH intact around run-agent; switch only the CLI process.
        if Path('/opt/node26/bin/node').exists():
            env['PATH'] = '/opt/node26/bin:' + env.get('PATH', '/usr/bin:/bin')
        arguments = [matches[0], *sys.argv[1:]]
        adapter = env.get('CARAPA_PI_MCP_ADAPTER')
        if command == 'pi' and adapter and (Path(adapter) / 'index.ts').is_file():
            # Honor an explicitly configured adapter; do not register it twice.
            settings = Path(env.get('PI_CODING_AGENT_DIR', str(Path(env.get('HOME', '/home/ubuntu')) / '.pi/agent'))) / 'settings.json'
            try:
                settings_data = json.loads(settings.read_text()) if settings.exists() else {}
            except ValueError:
                # Unparseable settings declare no packages; do not stop the launch.
                settings_data = {}
            packages = settings_data.get('packages') if isinstance(settings_data, dict) else None
            # Malformed settings (non-array packages, odd entries) must not stop launch.
            sources = [p if isinstance(p, str) else p.get('source') if isinstance(p, dict) else None
                       for p in (packages if isinstance(packages, list) else [])]
            sources = [source for source in sources if isinstance(source, str)]
            configured = any(re.search(r'(^|/|npm:)pi-mcp-adapter(@[^/]+)?/?$', source) for source in sources)
            if not configured:
                arguments[1:1] = ['--extension', str(Path(adapter) / 'index.ts')]
    os.execvpe(arguments[0], arguments, env)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit('Harness launch: ' + str(error))

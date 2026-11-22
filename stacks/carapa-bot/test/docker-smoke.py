#!/usr/bin/env python3
"""Opt-in real Docker validation. Uses disposable state/volumes, no agent homes."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

STACK = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('harness', STACK / 'harness.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='carapa-bot:0.1.0-test')
    parser.add_argument('--harness', action='append', help='real upstream harness to smoke-test; repeat for several')
    parser.add_argument('--browser', action='store_true', help='verify shared Chromium, sound and recording; requires Playwright')
    args = parser.parse_args()
    specs = args.harness or ['codex']
    names = {spec.split('@')[0] for spec in specs}
    if args.browser and 'playwright' not in names:
        parser.error('--browser requires --harness playwright')
    os.environ['CARAPA_BOT_IMAGE'] = args.image
    with tempfile.TemporaryDirectory(prefix='carapa-bot-smoke-') as tmp:
        store = harness.HarnessStore(Path(tmp))
        image = store.image()
        subprocess.run(['docker', 'run', '--rm', '--pull=never', '--network', 'none',
            '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
            '--entrypoint', '/bin/sh', image, '-ec',
            'test -x /usr/local/ai-cli-bin/run-agent.sh; '
            'test -f /usr/local/ai-cli-bin/runtime/runner.ts; '
            'test ! -e /usr/local/share/ca-certificates/carapa-local-root.crt; '
            'test ! -x /opt/carapa-harness/bin/codex; '
            'test "$(id -u)" = 1000; bun --version; npm --version; python3 --version'], check=True)
        try:
            store.install(['none'])
            empty = store.current()['volume']
            store.install(specs)
            installed = store.current()['volume']
            assert names <= store.current()['manifest']['harnesses'].keys()
            # Exercise the embedded entrypoint against an empty, disposable home.
            startup_check = 'test -x /usr/local/ai-cli-bin/run-agent.sh'
            if 'pi' in names:
                startup_check += "; jq -e '.packages | index(\"/opt/carapa-harness/harnesses/pi/lib/node_modules/pi-mcp-adapter\") != null' /home/ubuntu/.pi/agent/settings.json"
            store.container(image, installed, ['/usr/local/bin/entrypoint.sh', '/bin/sh', '-ec', startup_check],
                extra=['--tmpfs', '/workspace/ipc:uid=1000,gid=1000,mode=700',
                       '-e', 'CARAPA_SKIP_LOCAL_RESPONDER=1', '-e', 'ENABLE_SSHD=0'])
            if 'pi' in names:
                # Reusing a personalized home must not load the MCP adapter
                # twice. Exercise startup's repair and preserve package options.
                adapter = '/opt/carapa-harness/harnesses/pi/lib/node_modules/pi-mcp-adapter'
                for existing in ('npm:pi-mcp-adapter', {'source': 'npm:pi-mcp-adapter@1.0.0', 'extensions': ['index.ts']}):
                    settings = {'packages': [adapter, existing, 'npm:unrelated-extension'], 'theme': 'light'}
                    expected = {**settings, 'packages': [existing, 'npm:unrelated-extension']}
                    check = ('import json,os,pathlib,subprocess; '
                        'p=pathlib.Path("/home/ubuntu/.pi/agent/settings.json"); '
                        'p.parent.mkdir(parents=True); '
                        f'p.write_text({json.dumps(json.dumps(settings))}); '
                        'subprocess.run(["/usr/local/bin/entrypoint.sh","true"],check=True); '
                        'result=json.loads(p.read_text()); '
                        f'expected=json.loads({json.dumps(json.dumps(expected))}); '
                        'assert all(result[k]==v for k,v in expected.items()),result')
                    store.container(image, installed, ['python3', '-c', check],
                        extra=['--tmpfs', '/workspace/ipc:uid=1000,gid=1000,mode=700',
                               '-e', 'CARAPA_SKIP_LOCAL_RESPONDER=1', '-e', 'ENABLE_SSHD=0'])
            if args.browser:
                store.container(image, installed, ['/usr/local/ai-cli-bin/browser-viewer-check'],
                    extra=['--tmpfs', '/workspace/ipc:uid=1000,gid=1000,mode=700', '--shm-size=512m'])
            subprocess.run(['bun', '--no-env-file', str(STACK / 'check-harness.mjs'), tmp], check=True)
            # Resolve both public Compose variants with synthetic, non-secret inputs.
            (Path(tmp) / '.env').write_text('')
            compose_env = {**os.environ, 'WORKSPACE_PATH': '/workspace/code', 'LOCAL_REPO': tmp,
                'GROUP_DIR': tmp, 'AGENT_HOME': tmp, 'IPC_MOUNT': tmp, 'STACK_DIR': tmp,
                'COMPOSE_PROJECT_NAME': 'carapa-public-smoke', 'API_RELAY_IP': '172.30.0.2',
                'MEMORY_PROJECT': 'smoke'}
            for file in ('docker-compose.yml', 'docker-compose.git.yml'):
                shutil.copy2(STACK / file, Path(tmp) / file)
                model = json.loads(subprocess.check_output(['docker', 'compose', '--project-directory', tmp,
                    '-f', str(Path(tmp) / file), 'config', '--format', 'json'], env=compose_env, text=True))
                agent = model['services']['agent']
                assert agent['image'] == args.image and 'build' not in agent
                payload = next(v for v in agent['volumes'] if v['target'] == '/opt/carapa-harness')
                assert payload['read_only'] and payload['volume']['nocopy']
                assert model['volumes']['carapa_bot_harness']['name'] == installed
                assert all(v['target'] != '/usr/local/stack-cli-bin' for v in agent['volumes'])
            store.verify(image, empty)
            # Real failed installation must preserve selection and existing payloads.
            try:
                store.install(['codex@0.0.0-carapa-nonexistent-smoke-version'])
            except subprocess.CalledProcessError:
                pass
            else:
                raise AssertionError('Expected unavailable package version to fail')
            assert store.current()['volume'] == installed
            store.select(image, empty)
            store.select(image, installed)
            print('Real image, optional install, failure isolation, and rollback checks passed.')
        finally:
            volumes = {json.loads(file.read_text())['volume']
                       for file in store.state.glob('generations/*/selection.json')}
            for volume in volumes:
                harness.check_volume(volume)
                subprocess.run(['docker', 'volume', 'rm', volume], check=True)


if __name__ == '__main__':
    main()

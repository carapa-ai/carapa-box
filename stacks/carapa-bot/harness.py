#!/usr/bin/env python3
"""CarapaBox operator tool: install, validate and select immutable harness volumes.

Runs on the Docker host (or the CarapaBox controller), never in an agent.
Only the temporary installer gets network access and a writable payload mount.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import uuid

DEFAULT_STACK = Path(__file__).resolve().parent
LABEL = 'ai.carapa.bot-harness'
VOLUME_PATTERN = r'carapa-bot-harness-[0-9a-f]{32}'
sys.path.insert(0, str(DEFAULT_STACK / 'harness'))
from live import Store as LiveStore, ROOT as LIVE_ROOT


def selection_variant(selection):
    libc = selection.get('manifest', {}).get('abi', {}).get('libc', [None])[0]
    return {'glibc': 'debian', 'musl': 'alpine'}.get(libc)


def run(*args, capture=False, check=True):
    return subprocess.run(args, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def image_name(stack):
    # Read only this public setting; never evaluate a .env file as shell code.
    value = None
    env_file = stack / '.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            match = re.fullmatch(r'\s*(?:export\s+)?CARAPA_BOT_IMAGE\s*=\s*(.*?)\s*', line)
            if match:
                value = match[1].split(' #', 1)[0].strip().strip('\"\'')
    value = os.environ.get('CARAPA_BOT_IMAGE', value) or 'carapa-bot:0.1.0'
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9./_:@-]*', value):
        raise ValueError('CARAPA_BOT_IMAGE must be a literal, versioned Docker image reference')
    if value.split('@')[0].split('/')[-1].split(':')[0] == 'carapa-bot-agent':
        raise ValueError('carapa-bot-agent is reserved for the personalized stack')
    if '@sha256:' not in value and (':' not in value.split('/')[-1] or value.endswith(':latest')):
        raise ValueError('Use an explicit image version or digest, not latest')
    return value


class HarnessStore:
    def __init__(self, stack, variant=None):
        self.stack = stack
        self.state = stack / '.harness'
        self.variant = variant
        self.configured_image_ref = image_name(stack)
        self.image_ref = self.configured_image_ref
        if variant:
            selected = self.current(required=False)
            if selected and not os.environ.get('CARAPA_BOT_IMAGE'):
                # An inactive distribution keeps its own runtime, not the image
                # currently configured for the other distribution in .env.
                active = self.state / 'active/selection.json'
                active_variant = selection_variant(json.loads(active.read_text())) if active.exists() else None
                if active_variant != variant:
                    self.image_ref = selected['image_ref']

    def image(self):
        result = run('docker', 'image', 'inspect', self.image_ref, capture=True, check=False)
        if result.returncode:
            raise RuntimeError(f'Pull {self.image_ref} or build it with build.sh before installing harnesses')
        info = json.loads(result.stdout)[0]
        if (info['Config'].get('Labels') or {}).get('ai.carapa.harness-layout') != '1':
            raise RuntimeError('Image is not a compatible public CarapaBot runtime')
        return info['Id']

    def current(self, required=True):
        files = [self.state / 'active/selection.json']
        if self.variant:
            files.insert(0, self.state / 'variants' / self.variant / 'selection.json')
            # Import existing selections lazily; no rewrite or distro switch.
            files.extend(sorted(self.state.glob('generations/*/selection.json'),
                                key=lambda p: p.stat().st_mtime_ns, reverse=True))
        for file in files:
            if file.exists():
                selection = json.loads(file.read_text())
                if not self.variant or selection_variant(selection) == self.variant:
                    return selection
        if required:
            target = f' for {self.variant}' if self.variant else ''
            raise RuntimeError(f'No harness selection{target}. Run harness.py install <harness...> (or install none)')
        return None

    def managed(self, volume):
        if not re.fullmatch(VOLUME_PATTERN, volume):
            raise ValueError('Not a public CarapaBot harness volume')
        info = json.loads(run('docker', 'volume', 'inspect', volume, capture=True).stdout)[0]
        if (info.get('Labels') or {}).get(LABEL) != 'true':
            raise ValueError('Refusing an unmanaged volume')

    def container(self, image, volume, command, *, writable=False, network='none', extra=(), capture=False):
        return run('docker', 'run', '--rm', '--pull=never', '--network', network,
                   '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                   '--user', '1000:1000', '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777',
                   '--tmpfs', '/home/ubuntu:uid=1000,gid=1000,mode=700',
                   '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PI_SKIP_VERSION_CHECK=1',
                   '--mount', f'type=volume,src={volume},dst=/opt/carapa-harness,volume-nocopy' + ('' if writable else ',readonly'),
                   *extra, '--entrypoint', command[0], image, *command[1:], capture=capture)

    def manifest(self, image, volume):
        return json.loads(self.container(image, volume, ['/bin/cat', '/opt/carapa-harness/manifest.json'], capture=True).stdout)

    def verify(self, image, volume):
        if volume.startswith('carapa-harness-live-'):
            store = LiveStore(volume, image)
            data = store.current()
            store.python('import json,sys; from pathlib import Path; '
                         'assert json.loads(sys.argv[1]) == json.loads(Path("/usr/local/share/carapa/harness-abi.json").read_text()), "Harness/runtime ABI mismatch"', json.dumps(data['abi']))
            releases = {e['release'] for e in data['entries'].values()}
            for release in releases:
                store.helper(['python3', '/usr/local/lib/carapa-harness/verify.py'],
                    extra=['-e', 'CARAPA_HARNESS_ROOT=' + LIVE_ROOT + '/releases/' + release,
                        '--mount', f'type=bind,src={DEFAULT_STACK / "harness/verify.py"},dst=/usr/local/lib/carapa-harness/verify.py,readonly'])
            return {'abi': data['abi'], 'harnesses': {n: e['package'] for n, e in data['entries'].items()}}
        self.managed(volume)
        self.container(image, volume, ['python3', '/usr/local/lib/carapa-harness/verify.py'])
        return self.manifest(image, volume)

    def select(self, image, volume, manifest=None):
        if manifest is None: manifest = self.verify(image, volume)
        variant = selection_variant({'manifest': manifest})
        if self.variant and variant != self.variant:
            raise ValueError(f'Expected a {self.variant} harness volume, got {variant or "unknown ABI"}')
        generation = self.state / 'generations' / (volume + '-' + uuid.uuid4().hex)
        generation.mkdir(parents=True)
        selection = {'volume': volume, 'image': image, 'image_ref': self.image_ref, 'manifest': manifest}
        (generation / 'selection.json').write_text(json.dumps(selection, indent=2) + '\n')
        (generation / 'volumes.yml').write_text(
            'volumes:\n  carapa_bot_harness:\n    external: true\n    name: ' + volume + '\n')
        # Publish stack metadata after validating the complete selection.
        def publish(link_path):
            link_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=link_path.parent) as tmp:
                link = Path(tmp) / 'selection'
                link.symlink_to(os.path.relpath(generation, link_path.parent))
                link.replace(link_path)

        if variant:
            publish(self.state / 'variants' / variant)
        if not self.variant or self.image_ref == self.configured_image_ref:
            publish(self.state / 'active')
            print(f'Selected {volume} for {self.image_ref}. Stable-store consumers use it on their next run; legacy consumers need one recreation.')
        else:
            print(f'Updated {variant}: {volume}. The active stack selection is unchanged.')
        return selection

    def read_abi(self, image):
        return json.loads(run('docker', 'run', '--rm', '--pull=never', '--network', 'none',
            '--read-only', '--entrypoint', 'cat', image,
            '/usr/local/share/carapa/harness-abi.json', capture=True).stdout)

    def store_scope(self, variant, abi):
        return str(self.state.resolve()) + ':' + variant + ':' + json.dumps(abi, sort_keys=True)

    def live_store(self, variant, abi, image):
        return LiveStore.named(self.store_scope(variant, abi), image)

    def installer_mounts(self):
        files = [(DEFAULT_STACK / 'harness' / name, name) for name in ('install.py', 'verify.py')]
        files.append((DEFAULT_STACK / 'install-antigravity-acp.sh', 'install-antigravity-acp.sh'))
        return [part for src, name in files for part in (
            '--mount', f'type=bind,src={src},dst=/usr/local/lib/carapa-harness/{name},readonly')]

    def install_entry(self, store, image, spec):
        name = spec.split('@')[0]
        release = uuid.uuid4().hex
        root = LIVE_ROOT + '/releases/' + release
        store.python('from pathlib import Path; import sys; Path(sys.argv[1]).mkdir()', root, write=True)
        extra = ['-e', 'CARAPA_HARNESS_ROOT=' + root, *self.installer_mounts()]
        self.prepare_release(store, release, name)
        store.helper(['python3', '/usr/local/lib/carapa-harness/install.py', spec],
                     write=True, release=release, network='bridge', extra=extra)
        self.verify_release(store, release)
        manifest = json.loads(store.helper(['cat', root + '/manifest.json'], capture=True))
        return public_entry(name, release, manifest['harnesses'][name])

    def prepare_release(self, store, release, name):
        pass

    def verify_release(self, store, release):
        store.helper(['python3', '/usr/local/lib/carapa-harness/verify.py'],
                     extra=['-e', 'CARAPA_HARNESS_ROOT=' + LIVE_ROOT + '/releases/' + release,
                            *self.installer_mounts()])

    def install(self, specs, replace=False, update=False, configure=False):
        image = self.image()
        previous = self.current(required=update)
        abi = self.read_abi(image)
        variant = selection_variant({'manifest': {'abi': abi}})
        if self.variant and variant != self.variant:
            raise ValueError('Selected image does not match --variant ' + self.variant)
        if previous and previous['manifest']['abi'] != abi and not replace:
            raise ValueError('Runtime ABI changed; use install --replace and recreate sandboxes with the matching runtime.')
        old_harnesses = previous['manifest']['harnesses'] if previous else {}
        if specs == ['none']:
            if update or (previous and not (replace or configure)): raise ValueError('Use configure none for an empty selection')
            specs = []
        if update:
            specs = specs or list(old_harnesses)
            for spec in specs:
                if spec.split('@')[0] not in old_harnesses:
                    raise ValueError('Cannot update a harness that is not installed: ' + spec)
        self.container_validation(image, specs)
        store = self.live_store(variant, abi, image)
        store.ensure()
        current = store.current()
        if current and current.get('abi') != abi and not replace:
            raise ValueError('Runtime ABI changed; use install --replace. Recreate sandboxes for the new runtime.')
        entries = {} if replace else dict(current.get('entries', {}))
        if configure:
            wanted = {x.split('@')[0] for x in specs}
            entries = {n: e for n, e in entries.items() if n in wanted}
            specs = [x for x in specs if x.split('@')[0] not in entries or '@' in x]
        if previous and not current and not replace and not configure:
            # One-time migration: reinstall legacy packages at their resolved
            # versions into final immutable paths. Never move a Python venv.
            requested = {n: n if e['version'] == 'latest' else n + '@' + ('latest' if n in ('cursor', 'prime-agent') else e['version'])
                         for n, e in old_harnesses.items()}
            requested.update({x.split('@')[0]: x for x in specs})
            specs = list(requested.values())
        # One broken harness must not block the others. A failed one keeps its
        # previous release (or stays absent) and is reported after publication.
        failed = {}
        for spec in specs:
            name = spec.split('@')[0]
            try:
                entries[name] = self.install_entry(store, image, spec)
            except Exception as error:
                if len(specs) == 1: raise
                print(f'Harness {name} failed and was skipped: {error}', file=sys.stderr)
                failed[name] = error
        if specs and len(failed) == len(specs): raise next(iter(failed.values()))
        # Every replacement is verified before this single atomic publication.
        store.publish(entries, {'abi': abi, 'kind': getattr(self, 'kind', 'public')})
        self.select(image, store.volume, {'abi': abi, 'harnesses': {n: e['package'] for n, e in entries.items()}})
        removed = store.prune(apply=True)
        print(f'Cleaned {len(removed)} unused releases; current, per-harness rollback and sandbox boot leases retained.')
        if failed:
            kept = lambda n: 'kept ' + str(entries[n]['package'].get('version')) if n in entries else 'not installed'
            raise RuntimeError('Installed the rest, but these failed: ' + '; '.join(
                f'{n} ({kept(n)}, {type(e).__name__})' for n, e in failed.items()))

    def remove(self, names):
        selected = self.current()
        unknown = set(names) - selected['manifest']['harnesses'].keys()
        if unknown: raise ValueError('Not installed: ' + ', '.join(sorted(unknown)))
        remaining = [n for n in selected['manifest']['harnesses'] if n not in names]
        self.install(remaining or ['none'], configure=True)

    def migration_command(self):
        return ['python3', str(DEFAULT_STACK / 'harness.py'), '--stack-dir', str(self.stack),
                *(['--variant', self.variant] if self.variant else []), 'update']

    def cleanup(self, apply=False):
        selected = self.current()
        if not selected['volume'].startswith('carapa-harness-live-'):
            print('Cleanup skipped: the selected volume uses the legacy bundled format, without separate releases to clean up.')
            print('Nothing was deleted. To install the selected harnesses into the new release store, run:')
            print('  ' + shlex.join(self.migration_command()))
            print('This downloads harnesses. Existing sandboxes keep their old volume until recreated with the new mounts.')
            return
        removed = LiveStore(selected['volume'], self.image()).prune(apply=apply)
        print(('Removed ' if apply else 'Would remove ') + str(len(removed)) + ' unused releases: ' + ', '.join(removed))

    def rollback(self, names):
        selected = self.current()
        # Reject a runtime ABI mismatch before changing a live selection.
        self.verify(self.image(), selected['volume'])
        store = LiveStore(selected['volume'], self.image())
        store.rollback(names)
        self.select(self.image(), store.volume)

    def container_validation(self, image, specs):
        run('docker', 'run', '--rm', '--pull=never', '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--user', '1000:1000', '-e', 'PYTHONDONTWRITEBYTECODE=1',
            '--entrypoint', 'python3', image, '-c',
            'import sys; sys.path.insert(0,"/usr/local/lib/carapa-harness"); '
            'from install import parse_spec; [parse_spec(s) for s in sys.argv[1:]]', *specs)


def public_entry(name, release, package):
    directory = LIVE_ROOT + '/releases/' + release + '/harnesses/' + name
    env = {}
    if name == 'prime-agent': env['PRIME_AGENT_KERNEL_PYTHON'] = directory + '/venv/bin/python'
    if name == 'antigravity':
        env['CARAPA_AGY_PYTHON'] = directory + '/venv/bin/python'
        env['CARAPA_HARNESS_PYTHON_BIN'] = directory + '/venv/bin'
    if name == 'antigravity-acp':
        env['ANTIGRAVITY_ACP_BIN'] = directory + '/payload/antigravity'
    if name == 'playwright':
        env['CARAPA_PLAYWRIGHT_REAL'] = directory + '/bin/playwright-cli'
        env['CARAPA_PLAYWRIGHT_PACKAGE'] = directory + '/lib/node_modules/@playwright/cli'
        env['PLAYWRIGHT_BROWSERS_PATH'] = directory + '/browsers'
    if name == 'pi': env['CARAPA_PI_MCP_ADAPTER'] = directory + '/lib/node_modules/pi-mcp-adapter'
    return {'release': release, 'package': package, 'env': env,
            'commands': {c: 'harnesses/' + name + '/bin/' + c for c in package['commands']}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-dir', type=Path, default=DEFAULT_STACK)
    parser.add_argument('--variant', choices=('debian', 'alpine'),
                        help='operate on one distribution without switching the configured stack')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('image', help='print the configured versioned image')
    commands.add_parser('status', help='show selected volume and resolved versions')
    commands.add_parser('check', help='validate the selected image and volume offline')
    install = commands.add_parser('install', help='add/replace selected harnesses as independent immutable releases')
    install.add_argument('--replace', action='store_true', help='start a fresh set, also used after an ABI change')
    install.add_argument('harnesses', nargs='+', help='name[@version], or none for an empty set')
    update = commands.add_parser('update', help='update installed harnesses; omitted names means all')
    update.add_argument('harnesses', nargs='*')
    commands.add_parser('configure', help='choose the installed set, retaining unchanged versions').add_argument('harnesses', nargs='+')
    commands.add_parser('remove', help='disable harnesses for new runs; retain rollback and active files').add_argument('harnesses', nargs='+')
    commands.add_parser('select', help='select a previous compatible volume (rollback)').add_argument('volume')
    cleanup = commands.add_parser('cleanup', help='remove unused releases; retains rollback and sandbox boot leases')
    cleanup.add_argument('--apply', action='store_true')
    commands.add_parser('rollback', help='roll back selected harnesses independently').add_argument('harnesses', nargs='*')
    args = parser.parse_args()
    store = HarnessStore(args.stack_dir.resolve(), args.variant)
    if args.command == 'image':
        print(store.image_ref)
        return
    if args.command == 'status':
        print(json.dumps(store.current(), indent=2))
        return
    store.state.mkdir(parents=True, exist_ok=True)
    with (store.state / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.command == 'install':
            store.install(args.harnesses, replace=args.replace)
        elif args.command == 'update':
            store.install(args.harnesses, update=True)
        elif args.command == 'configure':
            store.install(args.harnesses, configure=True)
        elif args.command == 'remove':
            store.remove(args.harnesses)
        elif args.command == 'cleanup':
            store.cleanup(args.apply)
        elif args.command == 'rollback':
            store.rollback(args.harnesses)
        elif args.command == 'select':
            store.select(store.image(), args.volume)
        else:
            store.verify(store.image(), store.current()['volume'])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

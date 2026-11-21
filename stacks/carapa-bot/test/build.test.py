#!/usr/bin/env python3
"""Exercise the standalone build entry points without a Docker daemon."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


STACK = Path(__file__).resolve().parents[1]


class StandaloneBuild(unittest.TestCase):
    def test_build_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stack = root / 'stacks/carapa-bot'
            stack.mkdir(parents=True)
            for name in ('build.sh', 'harness.py', 'VERSION'):
                shutil.copy2(STACK / name, stack / name)
            shutil.copy2(STACK.parent / 'rebuild-agents.sh', stack.parent)
            (stack / '.env').write_text('CARAPA_BOT_IMAGE=example/carapa-bot:0.1.0\nENABLE_CODEX=1\n')
            commands = root / 'commands'
            commands.mkdir()
            log = root / 'docker.jsonl'
            docker = commands / 'docker'
            docker.write_text(
                '#!/usr/bin/env python3\n'
                'import json, os, sys\n'
                'with open(os.environ["BUILD_TEST_LOG"], "a") as f:\n'
                '    f.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                'sys.exit(int(os.environ.get("BUILD_TEST_EXIT", "0")))\n'
            )
            docker.chmod(0o755)
            env = {'PATH': str(commands) + os.pathsep + os.defpath,
                   'HOME': str(root), 'BUILD_TEST_LOG': str(log)}

            def invoke(script, *args, extra=None):
                log.unlink(missing_ok=True)
                result = subprocess.run(
                    ['/bin/sh', str(script), *args], cwd=root,
                    env={**env, **(extra or {})}, capture_output=True, text=True,
                )
                calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
                return result, calls

            result, calls = invoke(stack / 'build.sh', '--no-scan')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(calls), 1)
            command = calls[0]
            self.assertEqual(command[0], 'build')
            self.assertEqual(command[-3:], ['-t', 'example/carapa-bot:0.1.0', '.'])
            self.assertIn('CARAPA_BOT_VERSION=0.1.0', command)
            self.assertFalse(any(arg.startswith('ENABLE_') for arg in command))

            # An Alpine build must not overwrite the Debian tag from .env.
            result, calls = invoke(stack / 'build.sh', '--alpine', '--no-scan')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls[0][-3:], ['-t', 'carapa-bot:0.1.0-alpine', '.'])
            self.assertEqual(calls[0][calls[0].index('-f') + 1], 'Dockerfile.alpine')

            result, calls = invoke(stack.parent / 'rebuild-agents.sh', '--no-cache', '--no-scan')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(calls), 1)
            self.assertIn('--no-cache', calls[0])
            self.assertFalse(any(arg.startswith('AGENT_VERSION=') for arg in calls[0]))

            result, calls = invoke(stack / 'build.sh', '--update')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

            result, calls = invoke(stack / 'build.sh', '--no-scan', extra={'BUILD_TEST_EXIT': '17'})
            self.assertEqual(result.returncode, 17)
            self.assertEqual(len(calls), 1)

            # A security scan is a gate, including its actual subprocess status.
            trivy = commands / 'trivy'
            trivy.write_text(
                '#!/usr/bin/env python3\n'
                'import json, os, sys\n'
                'with open(os.environ["BUILD_TEST_LOG"], "a") as f:\n'
                '    f.write(json.dumps(["trivy", *sys.argv[1:]]) + "\\n")\n'
                'sys.exit(int(os.environ.get("SCAN_TEST_EXIT", "0")))\n'
            )
            trivy.chmod(0o755)
            result, calls = invoke(stack / 'build.sh', extra={'SCAN_TEST_EXIT': '1'})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(calls[1], ['trivy', 'image', '--scanners', 'vuln',
                '--severity', 'HIGH,CRITICAL', '--exit-code', '1', 'example/carapa-bot:0.1.0'])
            self.assertNotIn('Done.', result.stdout)

            # Restrict PATH so host scanners cannot mask a missing scanner.
            trivy.unlink()
            (commands / 'python3').symlink_to(sys.executable)
            for command in ('dirname', 'cat'):
                (commands / command).symlink_to(shutil.which(command))
            result, calls = invoke(stack / 'build.sh', extra={'PATH': str(commands)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls[-1], ['scout', 'cves', 'local://example/carapa-bot:0.1.0',
                '--only-severity', 'critical,high', '--exit-code'])
            docker.write_text(docker.read_text().replace(
                'sys.exit(int(os.environ.get("BUILD_TEST_EXIT", "0")))',
                'sys.exit(1 if sys.argv[1:3] == ["scout", "version"] else 0)'))
            result, calls = invoke(stack / 'build.sh', extra={'PATH': str(commands)})
            self.assertEqual(result.returncode, 1)
            self.assertIn('No CVE scanner found', result.stderr)
            self.assertNotIn('Done.', result.stdout)

            result, calls = invoke(stack.parent / 'rebuild-agents.sh', '--help')
            self.assertEqual(result.returncode, 0)
            self.assertEqual(calls, [])
            (stack / '.env').write_text('CARAPA_BOT_IMAGE=carapa-bot-agent:latest\n')
            result, calls = invoke(stack / 'build.sh', '--no-scan')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()

"""Exercise the actual workflow guard and fetch preflight, without network or ELF execution."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = (ROOT / '.github/workflows/offline.yml').read_text()
GUARD = textwrap.dedent(WORKFLOW.split("python3 - <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
REPOSITORY = 'merkr-software/cadencr-registry-qa'


class OfflineGuard(unittest.TestCase):
    def probe(self, version, env_overrides=None, fetch_suffix=None):
        with tempfile.TemporaryDirectory(prefix='offline-guard-test-') as scratch:
            root = Path(scratch)
            raw = f'CADENCR_RELEASE_VERSION={version}\nCADENCR_RELEASE_SHA256={"a" * 64}\n'
            (root / 'offline-cli-pin.env').write_text(raw)
            (root / 'offline-fetch-pin.env').write_text(
                raw + (fetch_suffix if fetch_suffix is not None else f'CADENCR_RELEASE_TAG=cli/v{version}\n'))
            env = dict(PATH=os.environ['PATH'], GITHUB_REPOSITORY=REPOSITORY,
                       GITHUB_REPOSITORY_ID='1420296872', GITHUB_REF='refs/heads/main',
                       GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_SHA='b' * 40,
                       GITHUB_WORKFLOW_REF=REPOSITORY + '/.github/workflows/offline.yml@refs/heads/main',
                       REVIEWED_COMMIT='b' * 40, PINS_SHA256=hashlib.sha256(raw.encode()).hexdigest())
            env.update(env_overrides or {})
            return subprocess.run(['python3', '-c', GUARD], cwd=root, env=env, capture_output=True).returncode

    def test_stable_and_existing_exact_development_versions(self):
        for version in ['0.14.1', '0.0.0', '10.20.30', '0.13.1-dev.39306959010.1']:
            with self.subTest(version=version):
                self.assertEqual(self.probe(version), 0)

    def test_noncanonical_versions_remain_rejected(self):
        for version in ['v0.14.1', '00.14.1', '0.014.1', '0.14.01', '0.14', '0.14.1-rc.1',
                        '0.14.1+build', '0.14.1-dev.0.1', '0.14.1-dev.1.0',
                        '0.14.1-dev.01.1', '0.14.1-dev.1.01', '0.14.1\nEXTRA=yes']:
            with self.subTest(version=version):
                self.assertNotEqual(self.probe(version), 0)

    def test_identity_review_and_pin_guards_remain_closed(self):
        for key, value in [('GITHUB_REPOSITORY', 'other/repo'), ('GITHUB_REPOSITORY_ID', '1'),
                           ('GITHUB_REF', 'refs/heads/other'), ('GITHUB_EVENT_NAME', 'push'),
                           ('GITHUB_WORKFLOW_REF', REPOSITORY + '/.github/workflows/other.yml@refs/heads/main'),
                           ('GITHUB_SHA', 'c' * 40), ('REVIEWED_COMMIT', 'bad'),
                           ('PINS_SHA256', 'c' * 64)]:
            with self.subTest(key=key):
                self.assertNotEqual(self.probe('0.14.1', {key: value}), 0)
        self.assertNotEqual(self.probe('0.14.1', fetch_suffix='CADENCR_RELEASE_TAG=v0.14.1\n'), 0)
        self.assertNotEqual(self.probe('0.14.1', fetch_suffix='CADENCR_RELEASE_TAG=cli/v0.14.2\n'), 0)

    def test_fetch_preflight_uses_exact_namespaced_url_without_network(self):
        for version, accepted in [('0.14.1', True), ('0.13.1-dev.39306959010.1', True),
                                  ('00.14.1', False), ('0.14.1-rc.1', False),
                                  ('0.14.1-dev.0.1', False), ('0.14.1-dev.1.01', False)]:
            with self.subTest(version=version), tempfile.TemporaryDirectory(prefix='offline-fetch-test-') as scratch:
                root = Path(scratch)
                pin = root / 'pin.env'
                pin.write_text(f'CADENCR_RELEASE_VERSION={version}\nCADENCR_RELEASE_SHA256={"a" * 64}\nCADENCR_RELEASE_TAG=cli/v{version}\n')
                bin_dir = root / 'bin'
                bin_dir.mkdir()
                marker = root / 'curl-args'
                curl = bin_dir / 'curl'
                curl.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{marker}"\nprintf 404\n')
                curl.chmod(0o700)
                result = subprocess.run(['sh', str(ROOT / 'scripts/fetch-released-cli.sh'), str(pin), str(root / 'output')],
                                        env={'PATH': str(bin_dir) + ':' + os.environ['PATH']}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(marker.exists(), accepted)
                if accepted:
                    self.assertEqual(marker.read_text().splitlines()[-1],
                                     f'https://github.com/merkr-software/CadencR/releases/download/cli/v{version}/cadencr-v{version}-x86_64-unknown-linux-gnu')
                    self.assertIn(b'HTTP 404', result.stderr)
                else:
                    self.assertFalse((root / 'output').exists())


if __name__ == '__main__':
    unittest.main()

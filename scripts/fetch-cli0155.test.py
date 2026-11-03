#!/usr/bin/env python3
"""Offline download-helper tests; fake assets are never CLI qualification evidence."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().with_name('fetch-cli0155.sh')
ASSET = 'cadencr-v0.15.5-x86_64-unknown-linux-gnu'
SOURCE = 'cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239'


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='fetch-cli0155-test-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.sentinel = self.root / 'ELF-WAS-EXECUTED'
        # Executable shell sentinel deliberately tests downloading, not ELF validity.
        payload = ('#!/bin/sh\n: > ' + shlex.quote(str(self.sentinel)) + '\nexit 99\n').encode()
        (self.assets / ASSET).write_bytes(payload)
        sha = hashlib.sha256(payload).hexdigest()
        pins = ('CADENCR_RELEASE_VERSION=0.15.5\nCADENCR_RELEASE_TAG=cli/v0.15.5\n'
                'CADENCR_RELEASE_SHA256=' + sha + '\n').encode()
        self.pin = self.root / 'pin.env'
        self.pin.write_bytes(pins)
        (self.assets / 'released-cli.env').write_bytes(pins)
        (self.assets / 'cadencr-v0.15.5-SHA256SUMS').write_text(sha + '  ' + ASSET + '\n')
        (self.assets / 'provenance.json').write_text(json.dumps({
            'repository': 'merkr-software/CadencR', 'source_commit': SOURCE,
            'version': '0.15.5', 'tag': 'cli/v0.15.5', 'asset': ASSET,
            'workflow': '.github/workflows/cli-release.yml', 'sha256': sha}))
        fake_curl = self.bin / 'curl'
        fake_curl.write_text('''#!/usr/bin/env python3
import os, pathlib, shutil, sys
root = pathlib.Path(''' + repr(str(self.root)) + ''')
args = sys.argv[1:]
assert args[:6] == ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto']
for option, value in {'--proto':'=https', '--proto-redir':'=https', '--max-redirs':'3',
        '--connect-timeout':'15', '--max-time':'120'}.items():
    assert args[args.index(option)+1] == value
base = 'https://github.com/merkr-software/CadencR/releases/download/cli/v0.15.5/'
urls = [arg for arg in args if arg.startswith('https:')]
assert len(urls) == 1 and urls[0].startswith(base)
name = urls[0][len(base):]
assert '/' not in name
limit = 134217728 if name == ''' + repr(ASSET) + ''' else 65536
assert args[args.index('--max-filesize')+1] == str(limit)
target = pathlib.Path(args[args.index('--output')+1])
assert target.is_absolute() and not target.exists()
with (root/'curl-calls').open('a') as calls:
    calls.write(name+'\\n')
shutil.copyfile(root/'assets'/name, target)
if os.environ.get('FAKE_CASE') == 'bad-digest' and name == ''' + repr(ASSET) + ''':
    with target.open('ab') as out:
        out.write(b'corrupt')
if os.environ.get('FAKE_CASE') == 'oversized' and name == 'provenance.json':
    with target.open('wb') as out:
        out.truncate(65537)
''')
        fake_curl.chmod(0o700)
        self.output = self.root / 'download'

    def invoke(self, case='', output=None):
        return subprocess.run(['sh', str(HELPER), str(self.pin), str(output or self.output)],
            env={'PATH': str(self.bin) + os.pathsep + os.environ['PATH'], 'FAKE_CASE': case},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        self.assertFalse(self.sentinel.exists(), 'downloaded sentinel was executed')
        binary = self.output / 'cadencr'
        if binary.exists():
            self.assertEqual(stat.S_IMODE(binary.stat().st_mode) & 0o111, 0)

    def test_downloads_four_bounded_assets_without_execution(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.decode().strip(), str(self.output / 'cadencr'))
        self.assertEqual((self.output / 'cadencr').read_bytes(), (self.assets / ASSET).read_bytes())
        self.assertEqual(stat.S_IMODE((self.output / 'cadencr').stat().st_mode), 0o700)
        self.assertFalse(self.sentinel.exists(), 'downloaded sentinel was executed')
        self.assertEqual((self.root / 'curl-calls').read_text().splitlines(),
            [ASSET, 'provenance.json', 'released-cli.env', 'cadencr-v0.15.5-SHA256SUMS'])

    def test_rejects_corrupted_binary(self):
        self.assert_rejected(self.invoke('bad-digest'))

    def test_rejects_oversized_metadata(self):
        self.assert_rejected(self.invoke('oversized'))

    def test_rejects_wrong_source_provenance(self):
        path = self.assets / 'provenance.json'
        value = json.loads(path.read_bytes())
        value['source_commit'] = 'a' * 40
        path.write_text(json.dumps(value))
        self.assert_rejected(self.invoke())

    def test_rejects_mismatched_released_pins(self):
        with (self.assets / 'released-cli.env').open('ab') as out:
            out.write(b'\n')
        self.assert_rejected(self.invoke())

    def test_rejects_mismatched_checksum_asset(self):
        (self.assets / 'cadencr-v0.15.5-SHA256SUMS').write_text('wrong checksum\n')
        self.assert_rejected(self.invoke())

    def test_rejects_other_versions_before_download(self):
        self.pin.write_text(self.pin.read_text().replace('0.15.5', '0.15.4'))
        self.assert_rejected(self.invoke())
        self.assertFalse((self.root / 'curl-calls').exists())
        self.assertFalse(self.output.exists())

    def test_rejects_duplicate_pin_fields(self):
        with self.pin.open('a') as out:
            out.write('CADENCR_RELEASE_VERSION=0.15.5\n')
        self.assert_rejected(self.invoke())
        self.assertFalse((self.root / 'curl-calls').exists())

    def test_refuses_existing_output(self):
        self.output.mkdir()
        owned = self.output / 'owned'
        owned.write_text('preserve')
        self.assert_rejected(self.invoke())
        self.assertEqual(owned.read_text(), 'preserve')
        self.assertFalse((self.root / 'curl-calls').exists())

    def test_refuses_relative_output(self):
        self.assert_rejected(self.invoke(output=Path('relative-download')))
        self.assertFalse((self.root / 'curl-calls').exists())

    def test_refuses_symlink_parent(self):
        linked = self.root / 'linked'
        linked.symlink_to(self.assets, target_is_directory=True)
        self.assert_rejected(self.invoke(output=linked / 'download'))
        self.assertFalse((self.root / 'curl-calls').exists())

    def test_refuses_dangling_symlink_output(self):
        self.output.symlink_to(self.root / 'missing', target_is_directory=True)
        self.assert_rejected(self.invoke())
        self.assertTrue(self.output.is_symlink())
        self.assertFalse((self.root / 'curl-calls').exists())


if __name__ == '__main__':
    unittest.main()

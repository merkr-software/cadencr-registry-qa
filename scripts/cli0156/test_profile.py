"""Non-network tests for authenticated finalization and profile isolation."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import cli_profile as profile
from finalize import finalize
import guard


class Profile(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='cli0156-profile-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.folder = self.root / 'requests/cli0156'
        self.folder.mkdir(parents=True)
        self.pending = (ROOT / profile.PROFILE).read_bytes()
        (self.root / profile.PROFILE).write_bytes(self.pending)
        binary = bytearray(64)
        binary[:6] = b'\x7fELF\x02\x01'
        binary[18:20] = b'\x3e\x00'
        self.asset = 'cadencr-v0.15.6-x86_64-unknown-linux-gnu'
        (self.assets / self.asset).write_bytes(binary)
        self.sha = hashlib.sha256(binary).hexdigest()
        self.value = dict(schema_version=1, status='FINALIZED_PUBLIC_RELEASE',
            repository='merkr-software/CadencR', version='0.15.6', tag='cli/v0.15.6',
            source_commit='a' * 40, cli_sha256=self.sha, run_id='123', run_attempt='1')
        provenance = {key: value for key, value in self.value.items() if key not in
                      ('schema_version', 'status', 'cli_sha256')}
        provenance.update(sha256=self.sha, asset=self.asset, workflow='.github/workflows/cli-release.yml')
        (self.assets / 'provenance.json').write_text(json.dumps(provenance))
        (self.assets / 'released-cli.env').write_bytes(profile.pin_bytes(self.value))
        (self.assets / 'cadencr-v0.15.6-SHA256SUMS').write_text(self.sha + '  ' + self.asset + '\n')

    def test_pending_profile_rejected_before_fetch_or_output_creation(self):
        with self.assertRaisesRegex(ValueError, 'CLI0156_PROFILE_PENDING'):
            profile.load(self.root)
        output = self.root / 'output'
        result = subprocess.run(['sh', str(ROOT / 'scripts/fetch-cli0156.sh'),
                                 str(self.assets / 'released-cli.env'), str(output)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'CLI0156_PROFILE_PENDING', result.stderr)
        self.assertFalse(output.exists())

    def test_finalization_requires_all_exact_public_bytes_and_preserves_history(self):
        historical = self.root / 'author-cli-pin.env'
        historical.write_bytes(b'historical-0155\n')
        value = finalize(self.assets, 'a' * 40, self.sha, self.root)
        self.assertEqual(value, self.value)
        self.assertEqual(profile.load(self.root), value)
        self.assertEqual(historical.read_bytes(), b'historical-0155\n')
        self.assertEqual((self.folder / 'released-cli.env').read_bytes(), profile.pin_bytes(value))
        with self.assertRaisesRegex(ValueError, 'already finalized'):
            finalize(self.assets, 'a' * 40, self.sha, self.root)

    def test_incorrect_confirmation_source_header_and_provenance_rejected(self):
        for source, checksum in [('b' * 40, self.sha), ('a' * 40, '0' * 64)]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                profile.authenticate_assets(self.assets, source, checksum)
        binary = self.assets / self.asset
        binary.write_bytes(b'not an ELF' + bytes(64))
        with self.assertRaisesRegex(ValueError, 'ELF'):
            profile.authenticate_assets(self.assets, 'a' * 40, hashlib.sha256(binary.read_bytes()).hexdigest())
        self.assertEqual((self.root / profile.PROFILE).read_bytes(), self.pending)
        self.assertFalse((self.folder / 'released-cli.env').exists())

    def test_rejects_unexpected_assets_symlinks_duplicate_json_and_pin_reformatting(self):
        extra = self.assets / 'extra'
        extra.write_bytes(b'')
        with self.assertRaises(ValueError):
            profile.authenticate_assets(self.assets, 'a' * 40, self.sha)
        extra.unlink()
        pin = self.assets / 'released-cli.env'
        pin.write_bytes(pin.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'pin bytes'):
            profile.authenticate_assets(self.assets, 'a' * 40, self.sha)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            profile.document('{"status":1,"status":2}')
        link = self.root / 'link'
        link.symlink_to(pin)
        with self.assertRaises(ValueError):
            profile.regular(link, 1024)

    def test_new_profile_guard_binds_review_identity_hash_and_pin(self):
        finalize(self.assets, 'a' * 40, self.sha, self.root)
        env = dict(GITHUB_REPOSITORY='merkr-software/cadencr-registry-qa',
            GITHUB_REPOSITORY_ID='1420296872', GITHUB_EVENT_NAME='workflow_dispatch',
            GITHUB_REF='refs/heads/main', REVIEWED_COMMIT='b' * 40, GITHUB_SHA='b' * 40,
            GITHUB_WORKFLOW_REF='merkr-software/cadencr-registry-qa/.github/workflows/cli0156-offline.yml@refs/heads/main',
            CLI0156_PROFILE_SHA256=hashlib.sha256((self.root / profile.PROFILE).read_bytes()).hexdigest())
        with patch.object(guard, 'ROOT', self.root), patch.object(guard, 'load', lambda: profile.load(self.root)):
            self.assertEqual(guard.guard(env), self.value)
            for key, value in [('GITHUB_REPOSITORY_ID', '1'), ('GITHUB_SHA', 'c' * 40),
                               ('CLI0156_PROFILE_SHA256', '0' * 64), ('GITHUB_REF', 'refs/heads/unreviewed')]:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    guard.guard(dict(env, **{key: value}))

    def test_finalizer_never_overwrites_existing_output(self):
        pin = self.folder / 'released-cli.env'
        pin.write_bytes(b'preexisting\n')
        with self.assertRaisesRegex(ValueError, 'new QA pin'):
            finalize(self.assets, 'a' * 40, self.sha, self.root)
        self.assertEqual(pin.read_bytes(), b'preexisting\n')
        self.assertEqual((self.root / profile.PROFILE).read_bytes(), self.pending)

    def test_profile_rejects_noncanonical_fields_and_types(self):
        for key, value in [('schema_version', True), ('source_commit', 'a' * 40 + '\n'),
                           ('cli_sha256', '0' * 63), ('run_id', '01'), ('run_attempt', 1),
                           ('repository', 'other/repo'), ('version', '0.15.5')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                profile.validate(dict(self.value, **{key: value}))
        with self.assertRaises(ValueError):
            profile.validate(dict(self.value, unexpected=True))

    def test_javascript_profile_matches_pending_and_exact_finalized_contract(self):
        module = (ROOT / 'scripts/cli0156/profile.mjs').as_uri()
        probe = 'import {profile0156} from ' + json.dumps(module) + '; profile0156(process.argv[1]);'
        def run():
            return subprocess.run(['node', '--input-type=module', '-e', probe, str(self.root)], capture_output=True)
        self.assertNotEqual(run().returncode, 0)
        finalize(self.assets, 'a' * 40, self.sha, self.root)
        self.assertEqual(run().returncode, 0)
        changed = dict(self.value, run_id='123\n')
        (self.root / profile.PROFILE).write_text(json.dumps(changed))
        self.assertNotEqual(run().returncode, 0)


if __name__ == '__main__':
    unittest.main()

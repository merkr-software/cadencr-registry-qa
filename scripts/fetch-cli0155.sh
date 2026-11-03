#!/bin/sh
# Download and authenticate release assets only. Never execute the downloaded CLI.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'usage: fetch-cli0155.sh <pin.env> <new-absolute-output-dir>' >&2
  exit 2
fi
exec python3 - "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def bounded_file(path, limit):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit,
            'unsafe or oversized release input: ' + path.name)
    return path.read_bytes()


os.umask(0o077)
version, tag = '0.15.5', 'cli/v0.15.5'
source = 'cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239'
asset = 'cadencr-v0.15.5-x86_64-unknown-linux-gnu'
pin_path, output = map(Path, sys.argv[1:])
pin_bytes = bounded_file(pin_path, 1024)
lines = pin_bytes.decode().splitlines()
require(len(lines) == 3 and all('=' in line for line in lines), 'invalid 0.15.5 pins')
pins = dict(line.split('=', 1) for line in lines)
require(set(pins) == {'CADENCR_RELEASE_VERSION', 'CADENCR_RELEASE_TAG', 'CADENCR_RELEASE_SHA256'}
        and pins['CADENCR_RELEASE_VERSION'] == version and pins['CADENCR_RELEASE_TAG'] == tag
        and re.fullmatch('[a-f0-9]{64}', pins['CADENCR_RELEASE_SHA256']), 'invalid 0.15.5 pins')
require(output.is_absolute() and not output.exists() and not output.is_symlink()
        and output.parent.is_dir() and output.parent.resolve() == output.parent,
        'output must be a new absolute directory with a canonical parent')
output.mkdir(mode=0o700)
base = 'https://github.com/merkr-software/CadencR/releases/download/' + tag
for name, destination, limit in [(asset, 'cadencr', 134217728),
        ('provenance.json', 'provenance.json', 65536),
        ('released-cli.env', 'released-cli.env', 65536),
        ('cadencr-v0.15.5-SHA256SUMS', 'cadencr-v0.15.5-SHA256SUMS', 65536)]:
    subprocess.run(['curl', '--disable', '--fail', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '3',
        '--connect-timeout', '15', '--max-time', '120', '--max-filesize', str(limit),
        base + '/' + name, '--output', str(output / destination)],
        check=True, timeout=135, stdout=subprocess.DEVNULL)
    bounded_file(output / destination, limit)
binary = bounded_file(output / 'cadencr', 134217728)
sha = hashlib.sha256(binary).hexdigest()
require(sha == pins['CADENCR_RELEASE_SHA256'], 'released CLI SHA-256 mismatch')
require(bounded_file(output / 'released-cli.env', 65536) == pin_bytes, 'released pins mismatch')
require(bounded_file(output / 'cadencr-v0.15.5-SHA256SUMS', 65536)
        == (sha + '  ' + asset + '\n').encode(), 'released checksums mismatch')
provenance = json.loads(bounded_file(output / 'provenance.json', 65536))
expected = {'repository': 'merkr-software/CadencR', 'source_commit': source,
    'version': version, 'tag': tag, 'asset': asset,
    'workflow': '.github/workflows/cli-release.yml', 'sha256': sha}
require(isinstance(provenance, dict) and all(provenance.get(k) == v for k, v in expected.items()),
        'released CLI provenance mismatch')
# Only authenticated bytes become executable; the caller owns all execution.
(output / 'cadencr').chmod(0o700)
print(output / 'cadencr')
PY

#!/usr/bin/env python3
"""Finalize QA-only pins from four authenticated public release assets; never executes the ELF."""
import argparse
import json
from pathlib import Path
from cli_profile import ROOT, PROFILE, authenticate_assets, document, pin_bytes, regular, require


def finalize(assets, source_commit, confirmation, root=ROOT):
    root = Path(root)
    old = document(regular(root / PROFILE, 4096))
    require(old.get('status') == 'AWAITING_PUBLIC_RELEASE', 'profile already finalized; do not replace it')
    value = authenticate_assets(assets, source_commit, confirmation)
    folder = root / 'requests/cli0156'
    outputs = {folder / 'released-cli.env': pin_bytes(value)}
    require(all(not path.exists() and not path.is_symlink() for path in outputs), 'new QA pin outputs required')
    for path, data in outputs.items():
        with path.open('xb') as stream:
            stream.write(data)
    # The explicit pending profile is the only existing file replaced by this local finalization.
    (root / PROFILE).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--confirm-cli-sha256', required=True)
    args = parser.parse_args()
    value = finalize(args.assets, args.source_commit, args.confirm_cli_sha256)
    print(json.dumps({'status': value['status'], 'version': value['version'],
                      'source_commit': value['source_commit'], 'cli_sha256': value['cli_sha256'],
                      'remote_writes': False, 'binary_executed': False}))

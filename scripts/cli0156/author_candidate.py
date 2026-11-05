#!/usr/bin/env python3
"""Bind a new inert QA author tag to the finalized public CLI; no tag/push/publication occurs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
from cli_profile import ROOT, load, require


def candidate(source, tag, account):
    profile = load()
    require(re.fullmatch('[a-f0-9]{40}', source) and re.fullmatch(r'qa-author-cli/[a-z0-9][a-z0-9-]{5,79}', tag),
            'exact inert QA source/tag required')
    require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9-]{0,38}', account), 'exact reviewed QA author account required')
    actual = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}'],
                                     text=True, stderr=subprocess.DEVNULL).strip()
    require(actual == source, 'immutable local source tag must already bind the reviewed QA fixture commit')
    value = dict(kind='lsp', cli_version=profile['version'], cli_sha256=profile['cli_sha256'],
        repository='merkr-software/cadencr-registry-qa', repository_id=1420296872, public=True,
        expected_account=account, tag=tag, source_commit=source)
    data = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    harness = runpy.run_path(str(ROOT / 'scripts/qualify-author-cli.py'))
    checksum = hashlib.sha256(data).hexdigest()
    harness['load_candidate'](data, checksum)
    output = ROOT / 'requests/cli0156/author-candidate.json'
    with output.open('xb') as stream:
        stream.write(data)
    return checksum


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--expected-account', required=True)
    args = parser.parse_args()
    print(candidate(args.source_commit, args.tag, args.expected_account))

#!/usr/bin/env python3
"""Require the finalized 0.15.7 public profile and exact reviewed QA dispatch before secrets."""
import hashlib
import os
import re
from pathlib import Path
from cli_profile import ROOT, PROFILE, load, pin_bytes, regular, require


def guard(env=os.environ):
    repo = 'merkr-software/cadencr-registry-qa'
    require(env.get('GITHUB_REPOSITORY') == repo and env.get('GITHUB_REPOSITORY_ID') == '1420296872',
            'wrong QA repository')
    require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and env.get('GITHUB_REF') == 'refs/heads/main',
            'reviewed QA main dispatch required')
    reviewed = env.get('REVIEWED_COMMIT', '')
    require(re.fullmatch('[a-f0-9]{40}', reviewed) and env.get('GITHUB_SHA') == reviewed,
            'reviewed QA source mismatch')
    workflows = ['cli0157-offline.yml', 'cli0157-author.yml', 'cli0157-registry.yml', 'cli0157-policy.yml']
    require(env.get('GITHUB_WORKFLOW_REF') in [repo + '/.github/workflows/' + name + '@refs/heads/main'
                                            for name in workflows], 'wrong CLI0157 workflow')
    raw = regular(ROOT / PROFILE, 4096)
    require(hashlib.sha256(raw).hexdigest() == env.get('CLI0157_PROFILE_SHA256'), 'reviewed profile hash mismatch')
    value = load()
    require(regular(ROOT / 'requests/cli0157/released-cli.env', 1024) == pin_bytes(value),
            'finalized public pin mismatch')
    return value


if __name__ == '__main__':
    value = guard()
    if os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as stream:
            stream.write('source_commit=' + value['source_commit'] + '\n')
    print('CLI0157_PROFILE_AUTHENTICATED')

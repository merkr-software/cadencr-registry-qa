"""Provider retirement checks using inert metadata and disposable offline keys."""
import copy
import hashlib
import json


def run(context):
    work, write, invoke = context['WORK'], context['write'], context['invoke']
    old = {'agent': {'id': 'qa-retired-provider', 'name': 'Inert provider',
        'version': '0.4.1', 'description': 'Never execute this fixture',
        'repository': 'https://github.com/original/qa-retired-provider', 'license': 'MIT',
        'distribution': {'binary': {'linux-x86_64': {'cmd': 'bin/provider',
            'sha256': 'a' * 64, 'archive': 'https://github.com/original/qa-retired-provider/releases/download/v0.4.1/provider.tar.gz'}}}},
        'host': {'publisher': 'original', 'compatibility': {'min_app_version': '999.0.0'},
                 'assets': {'icon': 'icon.svg', 'readme': 'README.md', 'license': 'LICENSE'}}}
    entry = {'kind': 'provider', 'package': old}
    record = {'provider_id': 'qa-retired-provider',
        'from': {'publisher': 'original', 'repository': old['agent']['repository']},
        'to': {'publisher': 'successor', 'repository': 'https://github.com/successor/qa-retired-provider'},
        'retired_versions': {'0.4.1': hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()},
        'authorization': 'https://github.com/owner/registry/pull/22#issuecomment-1',
        'reason': 'Inert offline provider ownership transfer fixture'}
    base, candidate = work / 'handoff-base', work / 'handoff-candidate'
    for folder in (base, candidate):
        (folder / 'packages').mkdir(parents=True)
        write(folder / 'packages/qa-retired-provider-0.4.1.json', old)
    write(candidate / 'provider-handoffs.json', [record])
    args = ['registry', 'validate', '--base', base, '--candidate', candidate]
    invoke('0157-handoff-ordinary-rejected', args, 'REGISTRY_VALIDATION_FAILED')
    invoke('0157-handoff-administrative-accepted', [*args, '--administrative'])
    # An accepted record constrains later ordinary version contributions.
    write(base / 'provider-handoffs.json', [record])
    invoke('0157-handoff-accepted-record-replay', args)
    immutable = candidate / 'packages/qa-retired-provider-0.4.1.json'
    immutable.rename(candidate / 'retained-old-package.json')
    invoke('0157-handoff-history-deletion-rejected', [*args, '--administrative'], 'REGISTRY_VALIDATION_FAILED')
    (candidate / 'retained-old-package.json').rename(immutable)
    changed = copy.deepcopy(old)
    changed['agent']['description'] = 'Changed historical metadata'
    immutable.write_text(json.dumps(changed))
    invoke('0157-handoff-history-mutation-rejected', [*args, '--administrative'], 'REGISTRY_VALIDATION_FAILED')
    immutable.write_text(json.dumps(old))
    payload = {'schema_version': 2, 'generated_at': context['GENERATED'],
        'expires_at': context['EXPIRES'], 'packages': [entry], 'provider_handoffs': [record]}
    source, signed = work / 'handoff-payload.json', work / 'handoff-signed.json'
    write(source, payload)
    sign = ['registry', 'sign-index', '--payload', source, '--private-key', work / 'private.pem',
            '--key-id', 'qa-lsp-offline-only', '--output', signed]
    invoke('0157-handoff-sign', sign)
    verify = ['registry', 'verify-index', '--index', signed, '--public-key', work / 'public.pem',
              '--key-id', 'qa-lsp-offline-only']
    invoke('0157-handoff-signature-verified', verify)
    tampered = json.loads(signed.read_bytes())
    tampered['signed']['provider_handoffs'][0]['reason'] = 'Tampered after signing'
    write(work / 'handoff-tampered.json', tampered)
    invoke('0157-handoff-tampering-rejected', [*verify[:3], work / 'handoff-tampered.json', *verify[4:]],
           'REGISTRY_VERIFICATION_FAILED')
    wrong = copy.deepcopy(payload)
    wrong['provider_handoffs'][0]['retired_versions']['0.4.1'] = '0' * 64
    write(work / 'handoff-wrong-digest.json', wrong)
    invoke('0157-handoff-wrong-digest-rejected', [*sign[:3], work / 'handoff-wrong-digest.json',
           *sign[4:-1], work / 'handoff-wrong-signed.json'], 'REGISTRY_SIGNING_FAILED')

"""Exact public CLI 0.15.7 profile; pending data never authorizes execution or publication."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
PROFILE = Path('requests/cli0157/profile.json')
FIELDS = {'schema_version', 'status', 'repository', 'version', 'tag', 'source_commit',
          'cli_sha256', 'run_id', 'run_attempt'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def document(data):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate JSON field')
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=unique)


def regular(path, maximum):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum,
            'bounded regular public release input required')
    return path.read_bytes()


def validate(value):
    require(isinstance(value, dict) and set(value) == FIELDS, 'invalid CLI0157 profile fields')
    require(type(value['schema_version']) is int and value['schema_version'] == 1,
            'invalid CLI0157 profile schema')
    require(value['status'] == 'FINALIZED_PUBLIC_RELEASE', 'CLI0157_PROFILE_PENDING')
    require(value['repository'] == 'merkr-software/CadencR' and value['version'] == '0.15.7'
            and value['tag'] == 'cli/v0.15.7', 'wrong CLI0157 release identity')
    for field, pattern in [('source_commit', r'[a-f0-9]{40}'), ('cli_sha256', r'[a-f0-9]{64}'),
                           ('run_id', r'[1-9][0-9]*'), ('run_attempt', r'[1-9][0-9]*')]:
        require(isinstance(value[field], str) and re.fullmatch(pattern, value[field]),
                'invalid CLI0157 ' + field)
    return value


def load(root=ROOT):
    return validate(document(regular(Path(root) / PROFILE, 4096)))


def pin_bytes(value):
    validate(value)
    return ('CADENCR_RELEASE_VERSION=0.15.7\nCADENCR_RELEASE_TAG=cli/v0.15.7\n'
            'CADENCR_RELEASE_SHA256=' + value['cli_sha256'] + '\n').encode()


def authenticate_assets(folder, source_commit, confirmation):
    folder = Path(folder)
    names = {'cadencr-v0.15.7-x86_64-unknown-linux-gnu', 'cadencr-v0.15.7-SHA256SUMS',
             'released-cli.env', 'provenance.json'}
    require({path.name for path in folder.iterdir()} == names, 'exact four release assets required')
    asset = 'cadencr-v0.15.7-x86_64-unknown-linux-gnu'
    binary = regular(folder / asset, 128 * 1024 * 1024)
    require(len(binary) >= 64 and binary[:6] == b'\x7fELF\x02\x01'
            and binary[18:20] == b'\x3e\x00', 'Linux x86_64 ELF required')
    checksum = hashlib.sha256(binary).hexdigest()
    require(checksum == confirmation, 'public binary checksum confirmation mismatch')
    provenance = document(regular(folder / 'provenance.json', 65536))
    require(set(provenance) == {'repository', 'source_commit', 'version', 'tag', 'run_id',
            'run_attempt', 'workflow', 'asset', 'sha256'}, 'unexpected release provenance fields')
    value = validate(dict(schema_version=1, status='FINALIZED_PUBLIC_RELEASE',
        repository=provenance['repository'], version=provenance['version'], tag=provenance['tag'],
        source_commit=source_commit, cli_sha256=checksum, run_id=provenance['run_id'],
        run_attempt=provenance['run_attempt']))
    require(provenance['source_commit'] == source_commit and provenance['sha256'] == checksum
            and provenance['workflow'] == '.github/workflows/cli-release.yml'
            and provenance['asset'] == asset, 'release provenance does not bind the confirmed source')
    require(regular(folder / 'released-cli.env', 1024) == pin_bytes(value), 'released pin bytes mismatch')
    require(regular(folder / 'cadencr-v0.15.7-SHA256SUMS', 1024)
            == (checksum + '  ' + asset + '\n').encode(), 'released checksum manifest mismatch')
    return value

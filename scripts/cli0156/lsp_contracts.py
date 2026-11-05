"""Additional 0.15.6 released-ELF contracts. Every server fixture remains inert data."""
import copy
import json
from pathlib import Path, PurePosixPath
import shutil
import struct
import tarfile

TYPESCRIPT_SHA256 = '295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286'
TARGETS = ('linux-x86_64', 'darwin-aarch64', 'darwin-x86_64')


def native_bundles(context):
    work, pack, invoke = context['WORK'], context['pack'], context['invoke']
    trees, targets = {}, {}
    for target, header in context['native_headers']().items():
        folder = work / ('0156-native-' + target)
        (folder / 'lib').mkdir(parents=True)
        (folder / 'server').write_bytes(header)
        (folder / 'server').chmod(0o700)
        (folder / 'lib/standard.lua').write_text('return {}\n')
        (folder / 'LICENSE').write_text('Inert upstream license fixture\n')
        targets[target] = pack('0156-native-data-' + target, folder, target, 'server', 'native')
        trees[target] = folder
    package = context['package']('qa-native-bundle-0156', targets)
    for target, folder in trees.items():
        context['write'](folder / 'lsp.json', package)
        archive = work / ('0156-native-data-' + target + '.tar.gz')
        args = ['plugin', 'validate', folder, '--kind', 'lsp', '--target', target, '--archive', archive]
        invoke('0156-target-archive-' + target, args)
        invoke('0156-reject-global-single-tree-' + target,
               ['plugin', 'validate', folder, '--kind', 'lsp'], 'LSP_VALIDATION_FAILED')
        other = next(name for name in trees if name != target)
        invoke('0156-reject-foreign-archive-' + target, args[:-1] + [work / ('0156-native-data-' + other + '.tar.gz')],
               'LSP_VALIDATION_FAILED')
        tampered = work / ('0156-tampered-' + target + '.tar.gz')
        tampered.write_bytes(archive.read_bytes() + b'tampered')
        invoke('0156-reject-tampered-archive-' + target, args[:-1] + [tampered], 'LSP_VALIDATION_FAILED')
        invalid = work / ('0156-invalid-metadata-' + target)
        invalid.mkdir()
        shutil.copy2(folder / 'server', invalid / 'server')
        changed = copy.deepcopy(package)
        changed['package']['lsp']['distribution']['binary'][other]['entry_sha256'] = 'invalid'
        context['write'](invalid / 'lsp.json', changed)
        invoke('0156-reject-unselected-metadata-' + target,
               ['plugin', 'validate', invalid, '--kind', 'lsp', '--target', target, '--archive', archive],
               'LSP_VALIDATION_FAILED')
    extra = work / '0156-extra-executable'
    extra.mkdir()
    for name in ('server', 'helper'):
        (extra / name).write_bytes(context['native_headers']()['linux-x86_64'])
        (extra / name).chmod(0o700)
    output = work / '0156-extra-executable.tar.gz'
    invoke('0156-reject-extra-executable', ['registry', 'pack-lsp', '--directory', extra,
        '--target', 'linux-x86_64', '--entry', 'server', '--runtime', 'native', '--output', output], 'LSP_PACKAGING_FAILED')
    context['require'](not output.exists(), 'extra executable rejection left an archive')
    return package


def macos_native_minimums(context):
    work, invoke, write = context['WORK'], context['invoke'], context['write']
    for platform in ['darwin-aarch64', 'darwin-x86_64']:
        for label, command in [
            ('build-version', [0x32, 24, 1, 15 << 16, 15 << 16, 0]),
            ('version-min-macosx', [0x24, 16, 15 << 16, 15 << 16])]:
            source = work / ('0156-macos-' + platform + '-' + label)
            source.mkdir()
            header = bytearray(context['native_headers']()[platform])
            count, size = struct.unpack_from('<II', header, 16)
            struct.pack_into('<II', header, 16, count + 1, size + len(command) * 4)
            header.extend(struct.pack('<' + 'I' * len(command), *command))
            (source / 'server').write_bytes(header)
            (source / 'server').chmod(0o700)
            pack_label = source.name + '-archive'
            target = context['pack'](pack_label, source, platform, 'server', 'native')
            package = context['package']('qa-minimum-' + platform.replace('_', '-') + '-' + label, {platform: target})
            archive = work / (pack_label + '.tar.gz')
            for floor, rejected in [('15.0.0', False), ('16.0.0', False), ('14.0.0', True)]:
                folder = work / (source.name + '-' + floor)
                folder.mkdir()
                shutil.copy2(source / 'server', folder / 'server')
                value = copy.deepcopy(package)
                value['package']['lsp']['distribution']['binary'][platform]['macos_min_version'] = floor
                write(folder / 'lsp.json', value)
                invoke('0156-macos-binary-minimum-' + platform + '-' + label + '-' + floor,
                    ['plugin', 'validate', folder, '--kind', 'lsp', '--target', platform, '--archive', archive],
                    'LSP_VALIDATION_FAILED' if rejected else None)


def entry_budgets(context):
    work, invoke = context['WORK'], context['invoke']
    folder = work / '0156-complete-typeshed'
    (folder / 'typeshed').mkdir(parents=True)
    (folder / 'server.js').write_text("throw new Error('never execute');\n")
    for index in range(5423):
        (folder / 'typeshed' / (str(index) + '.pyi')).write_text('value: str\n')
    target = context['pack']('0156-over-old-4096-budget', folder, 'linux-x86_64', 'server.js', 'node')
    # Root contains 1 directory and 1 entry; these files exceed 16,384 total entries.
    for index in range(5423, 16383):
        (folder / 'typeshed' / (str(index) + '.pyi')).write_text('value: str\n')
    output = work / '0156-over-new-budget.tar.gz'
    invoke('0156-reject-over-16384-budget', ['registry', 'pack-lsp', '--directory', folder,
        '--target', 'linux-x86_64', '--entry', 'server.js', '--runtime', 'node', '--output', output],
        'LSP_PACKAGING_FAILED')
    context['require'](not output.exists(), 'over-budget rejection left an archive')
    return context['package']('qa-node-minimum-0156', {'linux-x86_64': target})


def minimums(context, node_package, native_package):
    work, invoke, write = context['WORK'], context['invoke'], context['write']
    node = copy.deepcopy(node_package)
    native = copy.deepcopy(native_package)
    node_target = node['package']['lsp']['distribution']['binary']['linux-x86_64']
    node_target['node_min_version'] = '22.18.0'
    native_targets = native['package']['lsp']['distribution']['binary']
    for platform in ['darwin-aarch64', 'darwin-x86_64']:
        native_targets[platform]['macos_min_version'] = '15.0.0'
    folder = work / '0156-minimum-metadata'
    folder.mkdir()
    for label, package in [('node', node), ('native', native)]:
        path = folder / (label + '.json')
        write(path, package)
        invoke('0156-validate-' + label + '-minimum', ['registry', 'validate-metadata', path])
    invalid = []
    for field, package, platform in [('node_min_version', node, 'linux-x86_64'),
                                      ('macos_min_version', native, 'darwin-aarch64')]:
        for index, value in enumerate([None, True, 15, 15.5, {}, [], '', '15', '015.0.0', '15.0.0-rc.1', '15.0.0+build', '15.0.0\n']):
            changed = copy.deepcopy(package)
            changed['package']['lsp']['distribution']['binary'][platform][field] = value
            invalid.append((field + '-' + str(index), changed))
    for label, package, platform, field in [
        ('node-on-native', native, 'darwin-aarch64', 'node_min_version'),
        ('macos-on-linux', native, 'linux-x86_64', 'macos_min_version'),
        ('macos-on-node', node, 'linux-x86_64', 'macos_min_version')]:
        changed = copy.deepcopy(package)
        changed['package']['lsp']['distribution']['binary'][platform][field] = '15.0.0'
        invalid.append((label, changed))
    darwin_node = copy.deepcopy(node)
    darwin_node['package']['lsp']['distribution']['binary'] = {'darwin-aarch64': copy.deepcopy(node_target)}
    darwin_node['package']['lsp']['distribution']['binary']['darwin-aarch64']['macos_min_version'] = '15.0.0'
    invalid.append(('macos-on-darwin-node', darwin_node))
    for label, changed in invalid:
        path = work / ('0156-invalid-' + label + '.json')
        write(path, changed)
        invoke('0156-reject-' + label, ['registry', 'validate-metadata', path], 'REGISTRY_VALIDATION_FAILED')
    payload, signed = work / '0156-minimums.json', work / '0156-signed-minimums.json'
    invoke('0156-build-signed-minimums', ['registry', 'build-index', '--schema-version', '2', '--packages', folder,
        '--generated-at', context['GENERATED'], '--expires-at', context['EXPIRES'], '--output', payload])
    invoke('0156-sign-minimums', ['registry', 'sign-index', '--payload', payload, '--private-key', work / 'private.pem',
        '--key-id', 'qa-lsp-offline-only', '--output', signed])
    invoke('0156-verify-minimums', ['registry', 'verify-index', '--index', signed, '--public-key', work / 'public.pem',
        '--key-id', 'qa-lsp-offline-only'])
    entries = {item['package']['lsp']['id']: item for item in json.loads(signed.read_bytes())['signed']['packages']}
    context['require'](entries[node['package']['lsp']['id']] == node
        and entries[native['package']['lsp']['id']] == native, 'signed minimum requirements changed')
    context['require']('macos_min_version' not in native_targets['linux-x86_64']
        and 'node_min_version' not in native_targets['darwin-aarch64'], 'omitted requirements were synthesized')
    for field, identity, platform in [('node_min_version', node['package']['lsp']['id'], 'linux-x86_64'),
                                       ('macos_min_version', native['package']['lsp']['id'], 'darwin-aarch64')]:
        changed = json.loads(signed.read_bytes())
        item = next(item for item in changed['signed']['packages'] if item['package']['lsp']['id'] == identity)
        item['package']['lsp']['distribution']['binary'][platform][field] = '16.0.0'
        tampered = work / ('0156-tampered-signed-' + field + '.json')
        write(tampered, changed)
        invoke('0156-reject-tampered-signed-' + field, ['registry', 'verify-index', '--index', tampered,
            '--public-key', work / 'public.pem', '--key-id', 'qa-lsp-offline-only'], 'REGISTRY_VERIFICATION_FAILED')
    context['ARCHIVES'][signed.name] = context['digest'](signed.read_bytes())


def typescript_baseline(context):
    path = Path(context['os'].environ['CLI_TYPESCRIPT_BASELINE_ARCHIVE'])
    data = context['regular'](path, 32 * 1024 * 1024)
    context['require'](len(data) == 5014231 and context['digest'](data) == TYPESCRIPT_SHA256,
                       'published TypeScript baseline differs')
    folder = context['WORK'] / '0156-published-typescript'
    folder.mkdir()
    names = set()
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            context['require'](member.isfile() and not member.linkname and not name.is_absolute()
                and all(part not in ('', '.', '..') for part in member.name.split('/'))
                and member.name not in names and member.mode == 0o644 and member.size <= 32 * 1024 * 1024,
                'unsafe TypeScript baseline member')
            output = folder / name
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as stream:
                stream.write(archive.extractfile(member).read())
            names.add(member.name)
    context['require'](len(names) == 145, 'TypeScript baseline inventory differs')
    for target in TARGETS:
        signed = context['pack']('0156-published-typescript-' + target, folder, target, 'lib/cli.mjs', 'node')
        context['require'](signed['sha256'] == TYPESCRIPT_SHA256, 'TypeScript canonical bytes changed')


def run(context):
    native = native_bundles(context)
    macos_native_minimums(context)
    node = entry_budgets(context)
    minimums(context, node, native)
    typescript_baseline(context)

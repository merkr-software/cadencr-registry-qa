"""Pack all three contract targets and verify canonical contents independently."""
import json
from pathlib import PurePosixPath
import shutil
import tarfile

from common import digest, invoke, regular, require, write_json

TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-x86_64")
ENTRY = "lib/cli.mjs"
REPOSITORY = "https://github.com/merkr-software/CadencR"
PLANNED_TAG = "lsp-typescript-language-server-v0.1.0"


def tree_inventory(bundle, lock):
    expected = {}
    for source in lock["sources"]:
        prefix = "" if source["destination"] == "." else source["destination"] + "/"
        for file in source["files"]:
            expected[prefix + file["path"]] = {key: file[key] for key in ("sha256", "size")}
    actual = {}
    for path in bundle.rglob("*"):
        require(not path.is_symlink(), "bundle link refused")
        if path.is_dir():
            continue
        data = regular(path, 32 * 1024 * 1024)
        require(path.stat().st_mode & 0o777 == 0o644, "bundle mode mismatch")
        actual[path.relative_to(bundle).as_posix()] = {"sha256": digest(data), "size": len(data)}
    require(actual == expected and len(actual) <= 4096, "prepared bundle differs from source lock")
    return actual


def check_archive(path, expected):
    seen = set()
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = member.name
            require(name in expected and name not in seen and member.isfile()
                    and not member.linkname and not member.issparse(), "unexpected packed member")
            require(str(PurePosixPath(name)) == name and member.mode == 0o644
                    and member.uid == member.gid == member.mtime == 0, "noncanonical packed metadata")
            require(member.size == expected[name]["size"], "packed size mismatch")
            content = archive.extractfile(member).read(member.size + 1)
            require(digest(content) == expected[name]["sha256"], "packed file digest mismatch")
            seen.add(name)
    require(seen == set(expected), "missing packed files")


def pack_targets(cli, bundle, work, output, env, inventory):
    targets, receipts = {}, {}
    for target in TARGETS:
        name = f"lsp-typescript-language-server-0.1.0-{target}.tar.gz"
        path = output / name
        args = [cli, "--json", "registry", "pack-lsp", "--directory", bundle,
                "--target", target, "--entry", ENTRY, "--runtime", "node", "--output"]
        stdout, stderr = invoke([*args, path], work, env)
        receipt = json.loads(stdout)
        data = regular(path, 64 * 1024 * 1024)
        expected = {"kind": "lsp", "target": target, "runtime": "node", "entry": ENTRY,
            "archive": str(path), "sha256": digest(data), "size": len(data),
            "entry_sha256": inventory[ENTRY]["sha256"], "entry_size": inventory[ENTRY]["size"]}
        require(stderr == b"" and receipt == expected, "pack receipt mismatch")
        check_archive(path, inventory)
        repeat_path = work / ("repeat-" + target + ".tar.gz")
        repeated, stderr = invoke([*args, repeat_path], work, env)
        repeat = json.loads(repeated)
        require(stderr == b"" and repeat == dict(expected, archive=str(repeat_path))
                and regular(repeat_path, 64 * 1024 * 1024) == data, "non-deterministic package")
        receipts[target] = dict(expected, archive=name, deterministic=True)
        targets[target] = {key: receipt[key] for key in
            ("sha256", "size", "entry", "entry_sha256", "entry_size", "runtime")}
        targets[target]["archive"] = f"{REPOSITORY}/releases/download/{PLANNED_TAG}/{name}"
    write_json(output / "pack-receipts.json", receipts)
    return targets


def package(targets):
    languages = [("typescript", ["ts", "mts", "cts"]), ("typescriptreact", ["tsx"]),
                 ("javascript", ["js", "mjs", "cjs"]), ("javascriptreact", ["jsx"])]
    return {"kind": "lsp", "package": {"lsp": {
        "id": "typescript-language-server", "name": "TypeScript language server",
        "description": "TypeScript/JavaScript intelligence: TLS5.3.0 and TypeScript6.0.3; requires Node.js20+.",
        "version": "0.1.0", "repository": REPOSITORY, "license": "Apache-2.0",
        "protocol_version": 1, "languages": [{"id": name, "extensions": extensions, "filenames": []}
            for name, extensions in languages],
        "root_markers": ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
        "role": "type_checker", "args": ["--stdio"],
        "initialization_options": {"disableAutomaticTypingAcquisition": True},
        "distribution": {"binary": targets}}, "host": {
            "publisher": "merkr-software", "compatibility": {"min_app_version": "0.16.1"}}}}


def validate_package(cli, bundle, work, output, targets, env):
    value = package(targets)
    write_json(output / "package.json", value)
    validation = work / "validation"
    shutil.copytree(bundle, validation)
    write_json(validation / "lsp.json", value)
    stdout, stderr = invoke([cli, "--json", "plugin", "validate", validation, "--kind", "lsp"], work, env)
    require(stderr == b"" and b"typescript-language-server" in stdout, "manifest validation failed")
    return value

#!/usr/bin/env python3
"""Offline released-ELF checks; no publication or fixture server execution."""
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import socket
import struct
import subprocess
import sys
import tempfile
import tarfile
from datetime import datetime, timedelta, timezone


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")


def regular(path, limit):
    require(path.is_absolute() and not path.is_symlink() and path.is_file()
            and path.resolve() == path and path.stat().st_size <= limit, "unsafe input")
    return path.read_bytes()


def limits():
    bound = 64 * 1024 * 1024 if os.environ.get("QA_CLI_PROFILE") in ("cli0156", "cli0157") else 1024 * 1024
    resource.setrlimit(resource.RLIMIT_FSIZE, (bound, bound))


def invoke(label, args, code=None):
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.run([str(CLI), "--json", *map(str, args)], cwd=HOME,
            env={"PATH": "/usr/bin:/bin", "HOME": str(HOME),
                 "XDG_CONFIG_HOME": str(HOME / "config"), "LANG": "C.UTF-8"},
            stdout=out, stderr=err, timeout=90, preexec_fn=limits)
        require(out.tell() <= 1024 * 1024 and err.tell() <= 1024 * 1024, "output bound")
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(), err.read()
    if code:
        require(process.returncode == (3 if code == "OUTPUT_WRITE_FAILED" else 1)
                and stdout == b"", "unexpected rejection status: " + label)
        diagnostic = json.loads(stderr)
        require(diagnostic.get("ok") is False and diagnostic.get("code") == code,
                "unexpected diagnostic: " + label)
    else:
        require(process.returncode == 0 and stderr == b"", "CLI operation failed: " + label)
    CHECKS.append(label)
    return stdout


def check_archive(output, folder, runtime, entry):
    expected = {p.relative_to(folder).as_posix(): p.read_bytes()
                for p in folder.rglob('*') if p.is_file()}
    with tarfile.open(output, 'r:gz') as archive:
        members = archive.getmembers()
        require(len(members) == len(expected) and len({m.name for m in members}) == len(members),
                'unexpected or duplicate archive members')
        require({m.name for m in members} == set(expected), 'archive membership mismatch')
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and str(path) == member.name
                    and member.isfile() and not member.linkname, 'unsafe archive member')
            require(member.size == len(expected[member.name])
                    and member.mode == (0o755 if runtime == 'native' and member.name == entry else 0o644)
                    and member.uid == member.gid == member.mtime == 0, 'archive metadata mismatch')
            require(archive.extractfile(member).read() == expected[member.name], 'archive bytes mismatch')


def pack(label, folder, target, entry, runtime):
    output = WORK / (label + ".tar.gz")
    args = ["registry", "pack-lsp", "--directory", folder, "--target", target,
            "--entry", entry, "--runtime", runtime, "--output", output]
    receipt = json.loads(invoke(label, args))
    require(receipt["kind"] == "lsp" and receipt["target"] == target
            and receipt["runtime"] == runtime and receipt["entry"] == entry
            and receipt["sha256"] == digest(output.read_bytes())
            and receipt["size"] == output.stat().st_size
            and receipt["entry_sha256"] == digest((folder / entry).read_bytes())
            and receipt["entry_size"] == (folder / entry).stat().st_size, "pack receipt")
    check_archive(output, folder, runtime, entry)
    second = WORK / (label + "-second.tar.gz")
    retry = args[:-1] + [second]
    repeated = json.loads(invoke(label + "-deterministic", retry))
    require(repeated["sha256"] == receipt["sha256"]
            and second.read_bytes() == output.read_bytes(), "nondeterministic pack")
    invoke(label + "-overwrite", args, "LSP_PACKAGING_FAILED")
    require(digest(output.read_bytes()) == receipt["sha256"], "overwrite changed archive")
    ARCHIVES[output.name] = receipt["sha256"]
    return {key: value for key, value in receipt.items() if key not in ("kind", "target", "archive")} | {
        "archive": "https://github.com/merkr-software/cadencr-registry-qa/releases/download/qa-offline-lsp/" + output.name}


def package(identity, targets):
    return {"kind": "lsp", "package": {"lsp": {
        "id": identity, "name": "Inert QA LSP", "description": "Never execute this fixture",
        "version": "1.0.0", "repository": "https://github.com/merkr-software/cadencr-registry-qa",
        "license": "MIT", "protocol_version": 1,
        "languages": [{"id": "typescript", "extensions": ["ts"], "filenames": []}],
        "root_markers": ["package.json"], "role": "general", "args": ["--stdio"],
        "initialization_options": {}, "distribution": {"binary": targets}}, "host": HOST}}


def native_headers():
    def macho(cpu, signed):
        commands = [0x1b, 24, 0, 0, 0, 0] + ([0x1d, 16, 0, 0] if signed else [])
        header = [0xfeedfacf, cpu, 0, 2, 2 if signed else 1, len(commands) * 4, 0, 0]
        return struct.pack("<%dI" % (len(header) + len(commands)), *header, *commands)
    elf = bytearray(64)
    elf[:8] = b"\x7fELF\x02\x01\x01\x00"
    elf[16:20] = struct.pack("<HH", 2, 62)
    return {"linux-x86_64": bytes(elf), "darwin-x86_64": macho(0x01000007, False),
            "darwin-aarch64": macho(0x0100000c, True)}


def fixture_checks():
    node = WORK / "node"
    node.mkdir()
    (node / "server.js").write_text("throw new Error('QA fixture must never execute');\n")
    (node / "lib").mkdir()
    (node / "lib/dependency.mjs").write_text("export const inert = true;\n")
    targets = {target: pack("node-" + target, node, target, "server.js", "node")
               for target in ("linux-x86_64", "darwin-aarch64")}
    node_package = package("qa-inert-node-lsp", targets)
    write(node / "lsp.json", node_package)
    invoke("validate-node", ["plugin", "validate", node, "--kind", "lsp"])
    native_targets = {}
    native = WORK / "native"
    native.mkdir()
    for target, header in native_headers().items():
        entry = "bin/" + target + "/server"
        path = native / entry
        path.parent.mkdir(parents=True)
        path.write_bytes(header)
        path.chmod(0o700)
        isolated = WORK / ("native-source-" + target)
        (isolated / entry).parent.mkdir(parents=True)
        (isolated / entry).write_bytes(header)
        (isolated / entry).chmod(0o700)
        native_targets[target] = pack("native-" + target, isolated, target, entry, "native")
    native_package = package("qa-inert-native-lsp", native_targets)
    write(native / "lsp.json", native_package)
    invoke("validate-native-headers", ["plugin", "validate", native, "--kind", "lsp"])
    for label, key, value in [("digest", "entry_sha256", "0" * 64),
                               ("path", "entry", "../outside.js"), ("runtime", "runtime", "shell")]:
        invalid = copy.deepcopy(node_package)
        invalid["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"][key] = value
        (node / "lsp.json").write_text(json.dumps(invalid))
        invoke("reject-" + label, ["plugin", "validate", node, "--kind", "lsp"], "LSP_VALIDATION_FAILED")
    (node / "lsp.json").write_text(json.dumps(node_package))
    (node / "server.js").rename(node / "real.js")
    (node / "server.js").symlink_to("real.js")
    invoke("reject-entry-link", ["plugin", "validate", node, "--kind", "lsp"], "LSP_VALIDATION_FAILED")
    invoke("reject-pack-link", ["registry", "pack-lsp", "--directory", node, "--target", "linux-x86_64",
        "--entry", "server.js", "--runtime", "node", "--output", WORK / "rejected-link.tar.gz"], "LSP_PACKAGING_FAILED")
    require(not (WORK / "rejected-link.tar.gz").exists(), "rejected pack left output")
    (node / "server.js").unlink()
    (node / "real.js").rename(node / "server.js")
    (node / "lsp.json").rename(node / "real-metadata.json")
    (node / "lsp.json").symlink_to("real-metadata.json")
    invoke("reject-metadata-link", ["plugin", "validate", node, "--kind", "lsp"], "LSP_VALIDATION_FAILED")
    return [node_package, native_package]


def signed_checks(packages):
    folder = WORK / "packages"
    folder.mkdir()
    theme = {"kind": "theme", "package": {"theme": {"id": "qa-inert-theme", "name": "Inert theme",
        "description": "Offline metadata only", "version": "1.0.0", "license": "MIT", "document_version": 1,
        "repository": "https://github.com/merkr-software/cadencr-registry-qa", "distribution": {
            "archive": "https://github.com/merkr-software/cadencr-registry-qa/releases/download/qa-offline/theme.tar.gz",
            "sha256": "a" * 64}}, "host": HOST}}
    for index, value in enumerate([*packages, theme]):
        write(folder / (str(index) + ".json"), value)
    payload, signed = WORK / "payload.json", WORK / "signed.json"
    invoke("build-mixed-index", ["registry", "build-index", "--schema-version", "2", "--packages", folder,
        "--generated-at", GENERATED, "--expires-at", EXPIRES, "--output", payload])
    for name, args in [("private.pem", ["genpkey", "-algorithm", "ED25519"]),
                       ("public.pem", ["pkey", "-in", str(WORK / "private.pem"), "-pubout"])]:
        result = subprocess.run(["openssl", *args, "-out", str(WORK / name)],
            env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        require(result.returncode == 0, "disposable key generation failed")
    key_args = ["--private-key", WORK / "private.pem", "--key-id", "qa-lsp-offline-only"]
    verify_args = ["--public-key", WORK / "public.pem", "--key-id", "qa-lsp-offline-only"]
    invoke("sign-mixed-index", ["registry", "sign-index", "--payload", payload, *key_args, "--output", signed])
    invoke("verify-mixed-index", ["registry", "verify-index", "--index", signed, *verify_args])
    envelope = json.loads(signed.read_bytes())
    require(envelope["signed"]["schema_version"] == 2 and len(envelope["signed"]["packages"]) == 3
            and {v["kind"] for v in envelope["signed"]["packages"]} == {"lsp", "theme"}, "mixed index contents")
    if os.environ.get("QA_CLI_PROFILE") in ("cli0156", "cli0157"):
        actual = {value["package"]["lsp"]["id"]: value for value in envelope["signed"]["packages"]
                  if value["kind"] == "lsp"}
        require(all(actual[value["package"]["lsp"]["id"]] == value for value in packages),
                "omitted optional minima changed historical signed metadata")
    target = packages[0]["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"]
    policy = {"schema_version": 1, "kind": "lsp-blocklist", "generated_at": GENERATED,
        "expires_at": EXPIRES, "entries": [{"lsp_id": "qa-inert-node-lsp", "version_requirement": "=1.0.0",
        "archive_sha256": target["sha256"], "entry_sha256": target["entry_sha256"], "reason": "Inert test revocation"}]}
    policy_path, signed_policy = WORK / "policy.json", WORK / "signed-policy.json"
    write(policy_path, policy)
    invoke("sign-lsp-policy", ["registry", "sign-lsp-blocklist", "--payload", policy_path, *key_args, "--output", signed_policy])
    invoke("verify-lsp-policy", ["registry", "verify-lsp-blocklist", "--index", signed_policy, *verify_args])
    invoke("reject-wrong-namespace", ["registry", "verify-theme-blocklist", "--index", signed_policy, *verify_args], "REGISTRY_VERIFICATION_FAILED")
    wrong = copy.deepcopy(policy)
    wrong["kind"] = "theme-blocklist"
    write(WORK / "wrong-policy.json", wrong)
    invoke("reject-sign-wrong-namespace", ["registry", "sign-lsp-blocklist", "--payload", WORK / "wrong-policy.json",
        *key_args, "--output", WORK / "wrong-signed.json"], "REGISTRY_SIGNING_FAILED")
    altered = json.loads(signed_policy.read_bytes())
    altered["signed"]["entries"][0]["reason"] = "Changed authenticated bytes"
    write(WORK / "tampered-policy.json", altered)
    invoke("reject-tampered-policy", ["registry", "verify-lsp-blocklist", "--index", WORK / "tampered-policy.json",
        *verify_args], "REGISTRY_VERIFICATION_FAILED")
    for name in ("payload.json", "signed.json", "policy.json", "signed-policy.json"):
        ARCHIVES[name] = digest((WORK / name).read_bytes())


os.umask(0o077)
require(os.uname().sysname == "Linux" and os.uname().machine == "x86_64", "Linux x86_64 required")
require({name for _, name in socket.if_nameindex()} <= {"lo"}, "networkless namespace required")
require(not any(os.environ.get(name) for name in ("GH_TOKEN", "GITHUB_TOKEN", "QA_AUTHOR_GITHUB_TOKEN",
    "CADENCR_AUTHOR_GITHUB_TOKEN", "CADENCR_REGISTRY_GITHUB_TOKEN")), "credentials forbidden")
modern = os.environ.get("QA_CLI_PROFILE") in ("cli0156", "cli0157")
if modern:
    sys.path.insert(0, str(Path(__file__).resolve().parent / os.environ["QA_CLI_PROFILE"]))
    from cli_profile import load
    profile = load()
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    require(os.geteuid() != 0 and int(status["CapEff"].strip(), 16) == 0
        and int(status["CapBnd"].strip(), 16) == 0 and status["NoNewPrivs"].strip() == "1",
        "dropped privileges are required")
else:
    require(os.environ.get("QA_CLI_PROFILE") is None, "unknown CLI profile")
    profile = {"version": "0.15.5", "tag": "cli/v0.15.5"}
CLI = Path(os.environ["CLI"])
binary = regular(CLI, 128 * 1024 * 1024)
pins_path = Path(os.environ["CLI_QUALIFICATION_PINS"])
pin_bytes = regular(pins_path, 1024)
pins = dict(line.split("=", 1) for line in pin_bytes.decode().splitlines())
require(len(pin_bytes.decode().splitlines()) == len(pins) and set(pins) == {
    "CADENCR_RELEASE_VERSION", "CADENCR_RELEASE_TAG", "CADENCR_RELEASE_SHA256"}, "unexpected pins")
require(pins["CADENCR_RELEASE_VERSION"] == profile["version"] and pins["CADENCR_RELEASE_TAG"] == profile["tag"]
        and re.fullmatch("[a-f0-9]{64}", pins["CADENCR_RELEASE_SHA256"])
        and digest(binary) == pins["CADENCR_RELEASE_SHA256"]
        and binary[:6] == b"\x7fELF\x02\x01" and binary[18:20] == b"\x3e\x00", "wrong released ELF")
source = os.environ["CLI_RELEASE_SOURCE_COMMIT"]
require(re.fullmatch("[a-f0-9]{40}", source), "invalid source commit")
provenance_bytes = regular(Path(os.environ["CLI_RELEASE_PROVENANCE"]), 65536)
provenance = json.loads(provenance_bytes)
require(provenance["repository"] == "merkr-software/CadencR" and provenance["source_commit"] == source
    and provenance["version"] == profile["version"] and provenance["tag"] == profile["tag"]
    and provenance["asset"] == "cadencr-v" + profile["version"] + "-x86_64-unknown-linux-gnu"
    and provenance["workflow"] == ".github/workflows/cli-release.yml"
    and provenance["sha256"] == digest(binary), "provenance mismatch")
if modern:
    require(source == profile["source_commit"] and digest(binary) == profile["cli_sha256"]
        and provenance["run_id"] == profile["run_id"] and provenance["run_attempt"] == profile["run_attempt"],
        "finalized public release binding mismatch")
WORK = Path(os.environ["CLI_WORK_ROOT"])
require(WORK.is_absolute() and not WORK.exists() and not WORK.is_symlink()
    and WORK.parent.resolve() == WORK.parent and WORK.parent.is_dir(), "new canonical work directory required")
WORK.mkdir(mode=0o700)
HOME = WORK / "home"
HOME.mkdir()
CHECKS, ARCHIVES = [], {}
HOST = {"publisher": "qa-author", "compatibility": {"min_app_version": "999.0.0"}}
now = datetime.now(timezone.utc).replace(microsecond=0)
GENERATED = (now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
EXPIRES = (now + timedelta(days=1)).isoformat().replace("+00:00", "Z")
require(invoke("version", ["--version"]).decode().strip() == "cadencr " + profile["version"], "wrong version")
fixture_packages = fixture_checks()
try:
    signed_checks(fixture_packages)
    if modern:
        from lsp_contracts import run
        run(globals())
finally:
    # Remove only known generated disposable keys; retain scratch, never recurse.
    for key in ("private.pem", "public.pem"):
        (WORK / key).unlink(missing_ok=True)
(WORK / "evidence").mkdir()
write(WORK / "evidence/evidence.json", {"schema_version": 1, "qualification": "lsp-offline-only",
    "status": "passed", "version": profile["version"], "cli_sha256": digest(binary), "source_commit": source,
    "provenance_sha256": digest(provenance_bytes), "pins_sha256": digest(pin_bytes),
    "harness_sha256": digest(Path(__file__).read_bytes()), "checks": CHECKS, "artifact_sha256": ARCHIVES,
    "network": "isolated-loopback-only", "credentials": "none", "fixtures_executed": False,
    "native_fixture_scope": "synthetic ELF/Mach-O headers only; no native runtime conformance",
    "revocation_scope": "policy sign/verify and domain separation; no install/launch enforcement",
    "catalog_kinds": ["lsp", "theme"], "lifecycle_qualified": False,
    "public_publication": "not_requested", "production_pins_changed": False})

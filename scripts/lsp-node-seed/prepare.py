"""Offline candidate preparation with released ELF only; never publishes."""
import argparse
import json
import os
from pathlib import Path
import re
import socket

from common import clean_environment, digest, invoke, new_directory, regular, require, write_json
from packaging import pack_targets, tree_inventory, validate_package, PLANNED_TAG
from smoke import run_smoke
from sources import load_lock


def require_isolation():
    require(os.uname().sysname == "Linux" and os.uname().machine == "x86_64", "Linux x86_64 required")
    require(os.geteuid() != 0 and {name for _, name in socket.if_nameindex()} <= {"lo"},
            "unprivileged network namespace required")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    require(int(status["CapEff"].strip(), 16) == 0 and int(status["CapBnd"].strip(), 16) == 0
            and status["NoNewPrivs"].strip() == "1", "capabilities must be dropped")
    require(set(os.environ) <= {"PATH", "LC_CTYPE"}, "unexpected inherited environment")


def authenticate_cli(cli, pins_path, provenance_path):
    binary = regular(cli, 128 * 1024 * 1024)
    pin_bytes = regular(pins_path, 1024)
    lines = pin_bytes.decode().splitlines()
    require(len(lines) == 3 and lines[0] == "CADENCR_RELEASE_VERSION=0.15.5"
            and lines[1] == "CADENCR_RELEASE_TAG=cli/v0.15.5"
            and re.fullmatch("CADENCR_RELEASE_SHA256=[a-f0-9]{64}", lines[2]), "unexpected CLI pins")
    require(digest(binary) == lines[2].split("=", 1)[1] and binary[:6] == b"\x7fELF\x02\x01"
            and binary[18:20] == b"\x3e\x00", "exact pinned released ELF required")
    provenance_bytes = regular(provenance_path, 65536)
    provenance = json.loads(provenance_bytes)
    expected = {"repository": "merkr-software/CadencR", "version": "0.15.5", "tag": "cli/v0.15.5",
        "source_commit": "cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239",
        "asset": "cadencr-v0.15.5-x86_64-unknown-linux-gnu",
        "workflow": ".github/workflows/cli-release.yml", "sha256": digest(binary)}
    require(all(provenance.get(key) == value for key, value in expected.items()), "CLI provenance mismatch")
    return pin_bytes, expected, digest(provenance_bytes)


def build(cli, node, sources, work, output, lock, env):
    bundle = sources / "bundle"
    inventory = tree_inventory(bundle, lock)
    smoke = run_smoke(bundle, node, work, output / "smoke.json")
    require(tree_inventory(bundle, lock) == inventory, "smoke changed prepared source bytes")
    targets = pack_targets(cli, bundle, work, output, env, inventory)
    validate_package(cli, bundle, work, output, targets, env)
    require(tree_inventory(bundle, lock) == inventory, "packaging changed source bytes")
    write_json(output / "prepared-files.json", inventory)
    return {"checks": ["locked-source-tree", "real-node-stdio-smoke", "three-target-pack",
            "double-pack-determinism", "independent-archive-inventory", "CLI-manifest-validation"],
        "files": len(inventory), "expanded_bytes": sum(f["size"] for f in inventory.values()),
        "runtime_platform": smoke["platform"], "contract_targets": list(targets),
        "platform_limit": "Only the current Linux x86_64 runtime is exercised; both macOS runtimes remain unqualified."}


def run(args):
    require_isolation()
    os.umask(0o077)
    require(re.fullmatch("[a-f0-9]{40}", args.reviewed_commit), "exact reviewed QA commit required")
    raw, lock = load_lock(args.lock)
    require(regular(args.sources / "source-lock.json", 128 * 1024) == raw, "acquired source lock mismatch")
    pin_bytes, provenance, provenance_sha = authenticate_cli(args.cli, args.pins, args.provenance)
    node = args.node
    regular(node, 128 * 1024 * 1024)
    work, output = new_directory(args.work), new_directory(args.output)
    home = work / "home"
    home.mkdir()
    env = clean_environment(home, node)
    version, stderr = invoke([args.cli, "--version"], work, env)
    require(version.strip() == b"cadencr 0.15.5" and stderr == b"", "wrong CLI version")
    result = build(args.cli, node, args.sources, work, output, lock, env)
    (output / "source-lock.json").write_bytes(raw)
    (output / "lsp-cli-pin.env").write_bytes(pin_bytes)
    write_json(output / "cli-provenance.json", provenance)
    acquisition = json.loads(regular(args.sources / "acquisition.json", 65536))
    expected_acquisition = {"schema_version": 1, "source_lock_sha256": digest(raw),
        "integrity": "exact SHA512 npm and SHA256 plus every locked file verified",
        "sources": [{k: s[k] for k in ("name", "version", "commit", "sha256", "integrity", "size")}
                    for s in lock["sources"]], "installers_or_scripts_executed": False}
    require(acquisition == expected_acquisition, "source acquisition evidence mismatch")
    write_json(output / "acquisition.json", expected_acquisition)
    result.update({"schema_version": 1, "status": "passed", "scope": "held-real-node-seed-preparation",
        "package_version": "0.1.0", "min_app_version": "0.16.1", "reviewed_qa_commit": args.reviewed_commit,
        "source_lock_sha256": digest(raw), "pins_sha256": digest(pin_bytes),
        "cli_provenance_sha256": provenance_sha, "node": "22.19.0", "network": "isolated-loopback-only",
        "credentials": "none", "privileges": "non-root-capabilities-dropped-no-new-privs",
        "publication_not_requested": True, "production_unchanged": True,
        "planned_release_not_created": True, "planned_release_tag": PLANNED_TAG,
        "lifecycle_qualified": False, "runtime_minimum": "Node>=20 prerequisite; schema has no signed runtime minimum",
        "source_acquisition": "pre-namespace pinned official npm bytes; no npm or lifecycle scripts",
        "harness_sha256": {p.name: digest(p.read_bytes()) for p in Path(__file__).parent.glob("*.py")}})
    write_json(output / "evidence.json", result)
    files = sorted(path for path in output.iterdir() if path.is_file())
    (output / "SHA256SUMS").write_text("".join(digest(p.read_bytes()) + "  " + p.name + "\n" for p in files))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cli", "node", "sources", "lock", "pins", "provenance", "work", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--reviewed-commit", required=True)
    run(parser.parse_args())

"""Qualify the same-run Ubuntu-prepared Node archive on real macOS hardware."""
import argparse
import ctypes
import errno
import io
import json
import os
from pathlib import Path
import re
import socket
import sys
import tarfile

from common import clean_environment, digest, invoke, new_directory, regular, relative, require, write_json
from packaging import ENTRY, PLANNED_TAG, REPOSITORY, TARGETS, package, tree_inventory
from smoke import run_smoke
from sources import load_lock

PROFILE = "(version 1)(allow default)(deny network*)"
MACHINES = {"darwin-aarch64": ("arm64", "arm64", 1), "darwin-x86_64": ("x86_64", "x64", 0)}


def bound_json(path, expected_sha, limit=128 * 1024):
    raw = regular(path, limit)
    require(re.fullmatch("[a-f0-9]{64}", expected_sha) and digest(raw) == expected_sha,
            "same-run artifact digest mismatch: " + path.name)
    return json.loads(raw)


def verify_inputs(args):
    raw, lock = load_lock(args.lock)
    require(digest(raw) == args.source_lock_sha256
            and regular(args.artifact / "source-lock.json", 128 * 1024) == raw, "source lock binding mismatch")
    evidence = bound_json(args.artifact / "evidence.json", args.evidence_sha256)
    expected = {"status": "passed", "scope": "held-real-node-seed-preparation", "node": "22.19.0",
        "files": 145, "expanded_bytes": 26682278, "package_version": "0.1.0", "min_app_version": "0.16.1",
        "reviewed_qa_commit": args.reviewed_commit, "source_lock_sha256": args.source_lock_sha256,
        "pins_sha256": args.pins_sha256, "runtime_platform": "Linux/x86_64",
        "network": "isolated-loopback-only", "credentials": "none", "publication_not_requested": True,
        "production_unchanged": True, "planned_release_not_created": True, "planned_release_tag": PLANNED_TAG}
    require(all(evidence.get(k) == v for k, v in expected.items()), "Ubuntu preparation evidence mismatch")
    smoke_path = Path(__file__).parent / "smoke.py"
    require(evidence["harness_sha256"]["smoke.py"] == digest(smoke_path.read_bytes()), "smoke harness drift")
    inventory = bound_json(args.artifact / "prepared-files.json", args.inventory_sha256)
    locked = {}
    for source in lock["sources"]:
        prefix = "" if source["destination"] == "." else source["destination"] + "/"
        locked.update({prefix + f["path"]: {k: f[k] for k in ("sha256", "size")} for f in source["files"]})
    require(inventory == locked and len(inventory) == 145, "locked 145-file inventory mismatch")
    manifest = bound_json(args.artifact / "package.json", args.manifest_sha256)
    targets = manifest["package"]["lsp"]["distribution"]["binary"]
    require(set(targets) == set(TARGETS) and manifest == package(targets), "candidate manifest contract mismatch")
    target = targets[args.target]
    name = f"lsp-typescript-language-server-0.1.0-{args.target}.tar.gz"
    require(set(target) == {"archive", "sha256", "size", "entry", "entry_sha256", "entry_size", "runtime"}
        and target["archive"] == f"{REPOSITORY}/releases/download/{PLANNED_TAG}/{name}"
        and target["sha256"] == args.archive_sha256 and target["runtime"] == "node"
        and target["entry"] == ENTRY and target["entry_sha256"] == inventory[ENTRY]["sha256"]
        and target["entry_size"] == inventory[ENTRY]["size"], "target or entry binding mismatch")
    data = regular(args.artifact / name, 64 * 1024 * 1024)
    require(digest(data) == args.archive_sha256 and len(data) == target["size"], "archive binding mismatch")
    return data, lock, inventory


def extract_archive(data, inventory, bundle):
    seen = set()
    bundle.mkdir()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = member.name
            require(name in inventory and name not in seen and member.isfile() and not member.linkname
                    and not member.issparse(), "extra, duplicate or non-regular archive member")
            relative(name)
            require(member.mode == 0o644 and member.uid == member.gid == member.mtime == 0
                    and member.size == inventory[name]["size"], "noncanonical archive member")
            content = archive.extractfile(member).read(member.size + 1)
            require(len(content) == member.size and digest(content) == inventory[name]["sha256"],
                    "archive file digest mismatch")
            path = bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(content)
            path.chmod(0o644)
            seen.add(name)
    require(seen == set(inventory), "archive missing locked files")


def network_probe():
    checks = [(socket.AF_INET, "bind", ("127.0.0.1", 0)),
              (socket.AF_INET, "connect", ("192.0.2.1", 9)), (socket.AF_INET6, "bind", ("::1", 0))]
    for family, operation, address in checks:
        try:
            with socket.socket(family, socket.SOCK_STREAM) as connection:
                connection.settimeout(1)
                getattr(connection, operation)(address)
        except OSError as error:
            require(error.errno == errno.EPERM, "network denial must be sandbox EPERM")
        else:
            raise RuntimeError("sandbox network probe unexpectedly succeeded")
    return ["ipv4-loopback-bind-EPERM", "ipv4-outbound-connect-EPERM", "ipv6-loopback-bind-EPERM"]


def worker(args):
    require(set(os.environ) <= {"PATH", "HOME", "TMPDIR", "LANG", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"},
            "unexpected worker environment")
    require(Path(os.environ["HOME"]).resolve() == args.work / "home", "private worker HOME required")
    checks = network_probe()
    smoke = run_smoke(args.work / "bundle", args.node, args.work, args.output / "smoke.json")
    write_json(args.output / "sandbox.json", {"status": "passed", "network_checks": checks,
        "profile_sha256": digest(PROFILE.encode()), "smoke_status": smoke["status"]})


def sysctl_integer(name, optional=False):
    query = ctypes.CDLL(None, use_errno=True).sysctlbyname
    query.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                     ctypes.c_void_p, ctypes.c_size_t]
    query.restype = ctypes.c_int
    value, size = ctypes.c_int(), ctypes.c_size_t(ctypes.sizeof(ctypes.c_int))
    ctypes.set_errno(0)
    status = query(name.encode("ascii"), ctypes.byref(value), ctypes.byref(size), None, 0)
    error = ctypes.get_errno()
    if status == -1 and error == errno.ENOENT and optional:
        return None
    require(status == 0 and size.value == ctypes.sizeof(value), f"sysctl {name} failed: errno {error}")
    return value.value


def hardware(node, home, target):
    machine, node_arch, arm_flag = MACHINES[target]
    require(os.uname().sysname == "Darwin" and os.uname().machine == machine, "wrong actual macOS architecture")
    env = clean_environment(home, node)
    arm = sysctl_integer("hw.optional.arm64", optional=target == "darwin-x86_64")
    require(arm == arm_flag or (arm is None and arm_flag == 0), "wrong hardware architecture or Rosetta")
    require(sysctl_integer("sysctl.proc_translated", optional=True) in (None, 0), "Rosetta translation detected")
    output, stderr = invoke([node, "-p", "process.platform + '/' + process.arch"], home, env)
    require(output.decode().strip() == "darwin/" + node_arch and stderr == b"", "wrong Node runtime architecture")
    version, stderr = invoke(["/usr/bin/sw_vers", "-productVersion"], home, env)
    require(stderr == b"", "macOS version query failed")
    return {"os": "Darwin", "machine": machine, "node_arch": node_arch, "macos": version.decode().strip()}


def run(args):
    os.umask(0o077)
    require(re.fullmatch("[a-f0-9]{40}", args.reviewed_commit), "invalid reviewed commit")
    for value in (args.run_id, args.run_attempt, args.artifact_id):
        require(re.fullmatch("[1-9][0-9]*", value), "same-run artifact identity required")
    workflow = os.environ.get("GITHUB_ACTIONS") == "true"
    if workflow:
        expected_context = {"GITHUB_REPOSITORY": "merkr-software/cadencr-registry-qa",
            "GITHUB_REPOSITORY_ID": "1420296872", "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": args.reviewed_commit,
            "GITHUB_RUN_ID": args.run_id, "GITHUB_RUN_ATTEMPT": args.run_attempt}
        require(all(os.environ.get(k) == v for k, v in expected_context.items()), "workflow context mismatch")
    data, lock, inventory = verify_inputs(args)
    work, output = new_directory(args.work), new_directory(args.output)
    home = work / "home"
    home.mkdir()
    platform = hardware(args.node, home, args.target)
    extract_archive(data, inventory, work / "bundle")
    require(tree_inventory(work / "bundle", lock) == inventory, "extracted tree mismatch")
    sandbox = Path("/usr/bin/sandbox-exec")
    require(sandbox.is_file(), "sandbox-exec required; no isolation fallback")
    # Positive control: ordinary loopback bind works before the deny-network sandbox.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as control:
        control.bind(("127.0.0.1", 0))
    command = [sandbox, "-p", PROFILE, Path(sys.executable).resolve(), "-B", Path(__file__).resolve(), "--worker",
               "--node", args.node, "--work", work, "--output", output]
    stdout, stderr = invoke(command, work, clean_environment(home, args.node), timeout=120)
    require(stdout == stderr == b"", "unexpected sandbox worker output")
    require(tree_inventory(work / "bundle", lock) == inventory, "runtime changed extracted bundle")
    sandbox_result = json.loads(regular(output / "sandbox.json", 4096))
    require(sandbox_result["status"] == sandbox_result["smoke_status"] == "passed", "sandbox runtime failed")
    write_json(output / "runtime-evidence.json", {"schema_version": 1, "status": "passed", "target": args.target,
        "scope": "verified Linux-released-ELF archive; real macOS upstream LSP runtime", "platform": platform,
        "node": "22.19.0", "files": 145, "archive_sha256": args.archive_sha256,
        "manifest_sha256": args.manifest_sha256, "ubuntu_evidence_sha256": args.evidence_sha256,
        "inventory_sha256": args.inventory_sha256, "source_lock_sha256": args.source_lock_sha256,
        "reviewed_qa_commit": args.reviewed_commit, "same_run_bound": workflow,
        "execution_context": "GitHub workflow" if workflow else "local check outside GitHub workflow",
        "workflow_run_id": args.run_id if workflow else None,
        "workflow_run_attempt": args.run_attempt if workflow else None,
        "ubuntu_artifact_id": args.artifact_id if workflow else None,
        "network": "sandbox-exec-deny-network-tested", "credentials": "none", "HOME": "private",
        "min_app_version": "0.16.1", "publication_not_requested": True, "production_unchanged": True,
        "planned_release_not_created": True, "lifecycle_qualified": False,
        "limit": "Actual hosted OS/architecture only; no macOS12 minimum-OS, app install/UI/revocation qualification"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true")
    for name in ("node", "work", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("artifact", "lock"):
        parser.add_argument("--" + name, type=Path)
    for name in ("target", "archive-sha256", "manifest-sha256", "evidence-sha256", "inventory-sha256",
                 "source-lock-sha256", "pins-sha256", "reviewed-commit", "run-id", "run-attempt", "artifact-id"):
        parser.add_argument("--" + name)
    args = parser.parse_args()
    worker(args) if args.worker else run(args)

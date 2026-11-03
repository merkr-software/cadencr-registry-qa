"""Offline adversarial extraction, metadata and trust-boundary tests."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from common import digest, relative
from guard import guard
from packaging import package, TARGETS, tree_inventory
from prepare import authenticate_cli, require_isolation
from sources import extract_locked, load_lock, verify_tarball

ROOT = Path(__file__).parent.resolve()


def tarball(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(data)
            member.mode = 0o755
            if kind == tarfile.SYMTYPE:
                member.linkname = "../../outside"
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def specification(data, files):
    return {"size": len(data), "sha256": digest(data),
        "integrity": "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode(),
        "files": [{"path": name, "size": len(content), "sha256": digest(content)}
                  for name, content in files]}


class ExtractionTests(unittest.TestCase):
    def extract(self, entries, files):
        data = tarball(entries)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            extract_locked(data, specification(data, files), root)
            return {p.relative_to(root).as_posix(): (p.read_bytes(), p.stat().st_mode & 0o777)
                    for p in root.rglob("*") if p.is_file()}

    def test_regular_files_have_exact_bytes_and_normalized_modes(self):
        result = self.extract([("package/lib/cli.mjs", b"export {};", tarfile.REGTYPE)],
                              [("lib/cli.mjs", b"export {};")])
        self.assertEqual(result, {"lib/cli.mjs": (b"export {};", 0o644)})

    def test_refuses_links_traversal_noncanonical_paths_and_special_files(self):
        for name, kind in [("package/server.mjs", tarfile.SYMTYPE),
                           ("package/server.mjs", tarfile.LNKTYPE),
                           ("package/server.mjs", tarfile.FIFOTYPE),
                           ("package/../outside", tarfile.REGTYPE),
                           ("package//server.mjs", tarfile.REGTYPE),
                           ("/package/server.mjs", tarfile.REGTYPE),
                           ("package/.npmrc", tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind), self.assertRaises(RuntimeError):
                self.extract([(name, b"", kind)], [("server.mjs", b"")])

    def test_refuses_duplicate_extra_missing_and_changed_files(self):
        cases = [([("package/server.mjs", b"x", tarfile.REGTYPE)] * 2, [("server.mjs", b"x")]),
            ([("package/extra", b"x", tarfile.REGTYPE)], [("server.mjs", b"x")]),
            ([], [("server.mjs", b"x")]),
            ([("package/server.mjs", b"y", tarfile.REGTYPE)], [("server.mjs", b"x")]),
            ([("package/server.mjs", b"long", tarfile.REGTYPE)], [("server.mjs", b"x")])]
        for entries, files in cases:
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                self.extract(entries, files)

    def test_both_tarball_hash_algorithms_and_size_are_enforced(self):
        data = tarball([("package/server.mjs", b"x", tarfile.REGTYPE)])
        for key, value in [("sha256", "0" * 64), ("integrity", "sha512-AAAA"), ("size", len(data) + 1)]:
            spec = specification(data, [("server.mjs", b"x")])
            spec[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                verify_tarball(data, spec)


class ContractTests(unittest.TestCase):
    def test_real_lock_is_complete_and_exact(self):
        raw, lock = load_lock(ROOT / "source-lock.json")
        self.assertGreater(len(raw), 10000)
        self.assertEqual([(s["name"], s["version"]) for s in lock["sources"]],
                         [("typescript-language-server", "5.3.0"), ("typescript", "6.0.3")])
        self.assertEqual(sum(len(s["files"]) for s in lock["sources"]), 145)
        self.assertEqual(sum(s["expanded_size"] for s in lock["sources"]), 26682278)

    def test_lock_rejects_other_versions_origins_and_destinations(self):
        original = json.loads((ROOT / "source-lock.json").read_bytes())
        for key, value in [("version", "6.0.3"), ("tarball", "https://example.com/source.tgz"),
                           ("destination", "../outside")]:
            lock = copy.deepcopy(original)
            lock["sources"][0][key] = value
            with tempfile.TemporaryDirectory() as temp:
                path = Path(temp).resolve() / "lock.json"
                path.write_text(json.dumps(lock))
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    load_lock(path)

    def test_candidate_manifest_holds_rollout_and_real_languages(self):
        value = package({target: {"runtime": "node"} for target in TARGETS})
        self.assertEqual(value["package"]["host"]["compatibility"], {"min_app_version": "0.16.1"})
        lsp = value["package"]["lsp"]
        self.assertEqual(lsp["version"], "0.1.0")
        self.assertEqual(lsp["args"], ["--stdio"])
        self.assertEqual([l["id"] for l in lsp["languages"]],
                         ["typescript", "typescriptreact", "javascript", "javascriptreact"])

    def test_release_auth_rejects_native_source_binary_even_with_matching_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            cli, pins, provenance = [root / n for n in ["cli", "pins.env", "provenance.json"]]
            data = b"\xcf\xfa\xed\xfe" + b"x" * 50
            cli.write_bytes(data)
            pins.write_text("CADENCR_RELEASE_VERSION=0.15.5\nCADENCR_RELEASE_TAG=cli/v0.15.5\n"
                            "CADENCR_RELEASE_SHA256=" + digest(data) + "\n")
            provenance.write_text("{}")
            with self.assertRaisesRegex(RuntimeError, "ELF"):
                authenticate_cli(cli, pins, provenance)

    def test_isolation_has_no_local_bypass(self):
        with patch("os.uname", return_value=type("Host", (), {"sysname": "Darwin", "machine": "arm64"})()):
            with self.assertRaisesRegex(RuntimeError, "Linux"):
                require_isolation()

    def test_payload_path_policy(self):
        for path in ["../x", "x/../y", "x//y", "x/./y", "/x", ".npmrc", "x\\y", "x/é"]:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                relative(path)

    def test_dispatch_guard_binds_both_input_digests_and_exact_context(self):
        lock = (ROOT / "source-lock.json").read_bytes()
        pins = ("CADENCR_RELEASE_VERSION=0.15.5\nCADENCR_RELEASE_TAG=cli/v0.15.5\n"
                "CADENCR_RELEASE_SHA256=" + "a" * 64 + "\n").encode()
        repository = "merkr-software/cadencr-registry-qa"
        env = {"GITHUB_REPOSITORY": repository, "GITHUB_REPOSITORY_ID": "1420296872",
            "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_WORKFLOW_REF": repository + "/.github/workflows/lsp-node-seed.yml@refs/heads/main",
            "GITHUB_SHA": "a" * 40, "REVIEWED_COMMIT": "a" * 40,
            "SOURCE_LOCK_SHA256": digest(lock), "PINS_SHA256": digest(pins)}
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "scripts/lsp-node-seed").mkdir(parents=True)
            (root / "scripts/lsp-node-seed/source-lock.json").write_bytes(lock)
            (root / "lsp-cli-pin.env").write_bytes(pins)
            try:
                os.chdir(root)
                with patch.dict(os.environ, env, clear=True):
                    guard()
                for key, value in [("GITHUB_REPOSITORY_ID", "1"), ("GITHUB_REF", "refs/heads/other"),
                    ("GITHUB_EVENT_NAME", "push"), ("REVIEWED_COMMIT", "b" * 40),
                    ("PINS_SHA256", "b" * 64), ("SOURCE_LOCK_SHA256", "b" * 64)]:
                    with self.subTest(key=key), patch.dict(os.environ, dict(env, **{key: value}), clear=True):
                        with self.assertRaises(RuntimeError):
                            guard()
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()

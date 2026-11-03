"""Adversarial archive and sandbox checks for the Mac artifact consumer."""
import errno
import ctypes
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from common import digest
from mac_runtime import bound_json, extract_archive, hardware, network_probe, sysctl_integer


def tarball(name="lib/server.mjs", content=b"export {};", mode=0o644, kind=tarfile.REGTYPE, repeat=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        member = tarfile.TarInfo(name)
        member.type, member.mode, member.size = kind, mode, len(content)
        if kind == tarfile.SYMTYPE:
            member.linkname = "../../outside"
        archive.addfile(member, io.BytesIO(content))
        if repeat:
            archive.addfile(member, io.BytesIO(content))
    return output.getvalue()


class MacRuntimeTests(unittest.TestCase):
    def test_exact_archive_extracts_to_regular_mode644_files(self):
        expected = {"lib/server.mjs": {"sha256": digest(b"export {};"), "size": 10}}
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary) / "bundle"
            extract_archive(tarball(), expected, bundle)
            self.assertEqual((bundle / "lib/server.mjs").read_bytes(), b"export {};")
            self.assertEqual((bundle / "lib/server.mjs").stat().st_mode & 0o777, 0o644)

    def test_archive_rejects_duplicates_links_traversal_digest_and_modes(self):
        expected = {"lib/server.mjs": {"sha256": digest(b"export {};"), "size": 10}}
        bad = [tarball(repeat=True), tarball(kind=tarfile.SYMTYPE), tarball(name="../outside"),
               tarball(mode=0o755), tarball(content=b"changed!!!"), tarball(name="extra")]
        for data in bad:
            with tempfile.TemporaryDirectory() as temporary, self.assertRaises(RuntimeError):
                extract_archive(data, expected, Path(temporary) / "bundle")
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(RuntimeError):
            extract_archive(tarball(name="../outside"),
                {"../outside": expected["lib/server.mjs"]}, Path(temporary) / "bundle")

    def test_same_run_metadata_digest_is_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / "evidence.json"
            raw = json.dumps({"status": "passed"}).encode()
            path.write_bytes(raw)
            self.assertEqual(bound_json(path, digest(raw)), {"status": "passed"})
            with self.assertRaises(RuntimeError):
                bound_json(path, "0" * 64)

    def test_network_probe_requires_actual_sandbox_permission_denials(self):
        with patch("socket.socket", side_effect=PermissionError(errno.EPERM, "sandbox")):
            self.assertEqual(len(network_probe()), 3)
        for error in [ConnectionRefusedError(errno.ECONNREFUSED, "no listener"),
                      TimeoutError(errno.ETIMEDOUT, "no route")]:
            with patch("socket.socket", side_effect=error), self.assertRaises(RuntimeError):
                network_probe()

    def test_wrong_hardware_and_rosetta_are_rejected(self):
        arm = type("Host", (), {"sysname": "Darwin", "machine": "arm64"})()
        with patch("os.uname", return_value=arm), self.assertRaises(RuntimeError):
            hardware(Path("/node"), Path("/home"), "darwin-x86_64")
        intel = type("Host", (), {"sysname": "Darwin", "machine": "x86_64"})()
        with patch("os.uname", return_value=intel), patch("mac_runtime.sysctl_integer", return_value=1):
            with self.assertRaisesRegex(RuntimeError, "Rosetta"):
                hardware(Path("/node"), Path("/home"), "darwin-x86_64")

    def test_native_hardware_accepts_exact_missing_intel_oids_and_arm_native(self):
        for target, machine, values, node in [("darwin-x86_64", "x86_64", [None, None], b"darwin/x64\n"),
                                            ("darwin-aarch64", "arm64", [1, 0], b"darwin/arm64\n")]:
            host = type("Host", (), {"sysname": "Darwin", "machine": machine})()
            with patch("os.uname", return_value=host), patch("mac_runtime.sysctl_integer", side_effect=values), \
                    patch("mac_runtime.invoke", side_effect=[(node, b""), (b"15.0\n", b"")]):
                self.assertEqual(hardware(Path("/node"), Path("/home"), target)["machine"], machine)
        host = type("Host", (), {"sysname": "Darwin", "machine": "x86_64"})()
        with patch("os.uname", return_value=host), patch("mac_runtime.sysctl_integer", side_effect=[None, 1]):
            with self.assertRaisesRegex(RuntimeError, "Rosetta"):
                hardware(Path("/node"), Path("/home"), "darwin-x86_64")

    def test_only_actual_enoent_is_an_optional_missing_sysctl(self):
        for error in [errno.ENOENT, errno.EPERM, errno.EIO, errno.EINVAL]:
            query = type("Query", (), {"__call__": lambda self, *args: (ctypes.set_errno(error), -1)[1]})()
            library = type("Library", (), {"sysctlbyname": query})()
            with patch("ctypes.CDLL", return_value=library):
                if error == errno.ENOENT:
                    self.assertIsNone(sysctl_integer("hw.optional.arm64", optional=True))
                else:
                    with self.assertRaises(RuntimeError):
                        sysctl_integer("hw.optional.arm64", optional=True)
                with self.assertRaises(RuntimeError):
                    sysctl_integer("hw.optional.arm64")


if __name__ == "__main__":
    unittest.main()

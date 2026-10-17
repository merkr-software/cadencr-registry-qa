"""Offline guard and orchestration tests: never authorize remote publication."""
import importlib.util
import json
import os
import socket
import sys
import threading
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "qualification", Path(__file__).resolve().parents[1] / "qualify-author-cli.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def candidate():
    return dict(cli_version="1.2.3", cli_sha256="b"*64, repository=qa.REPOSITORY,
                repository_id=qa.REPOSITORY_ID, public=True, expected_account="qa-author",
                tag="qa-author-cli/fixture-001", source_commit="a"*40)


sys.path.insert(0, str(Path(__file__).parent))
from proxy import Gate, Tunnel


class Guards(unittest.TestCase):
    def test_proxy_upload_gate_and_destination_rejection(self):
        gate = Gate.__new__(Gate)
        gate.server_address = ("127.0.0.1", 1234)
        gate.upload_held = threading.Event()
        gate.api_seen = threading.Event()
        gate.stop = threading.Event()
        gate.stop.set()
        env = gate.environment({"NO_PROXY": "*", "https_proxy": "bad", "HOME": "/x"})
        self.assertEqual(set(env), {"HOME", "HTTPS_PROXY"})
        class Connection:
            def __init__(self, host):
                self.host = host
                self.sent = b""
            def settimeout(self, value):
                pass
            def recv(self, limit):
                return b"CONNECT " + self.host + b":443 HTTP/1.1\r\n\r\n"
            def sendall(self, data):
                self.sent += data
        tunnel = Tunnel.__new__(Tunnel)
        tunnel.server = gate
        tunnel.request = Connection(b"uploads.github.com")
        thread = threading.Thread(target=tunnel.tunnel)
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(gate.upload_held.is_set())
        self.assertFalse(gate.api_seen.is_set())
        tunnel.request = Connection(b"evil.example")
        tunnel.tunnel()
        self.assertIn(b"403 Forbidden", tunnel.request.sent)

    def test_interruption_observation_precedes_owned_termination(self):
        import interruption
        trace = []
        class FakeGate:
            def __init__(self):
                self.api_seen = threading.Event()
                self.upload_held = threading.Event()
                self.api_seen.set()
                self.upload_held.set()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def environment(self, env):
                return env
        class Process:
            returncode = None
            def poll(self):
                return self.returncode
            def terminate(self):
                trace.append("terminate-owned")
                self.returncode = -15
            def wait(self, timeout):
                trace.append("wait-owned")
        c = candidate()
        bound = {"id": 123, "draft": True, "prerelease": True, "tag_name": c["tag"],
                 "target_commitish": c["source_commit"],
                 "body": "Inert original-author CLI qualification.\n\n"
                         "<!-- cadencr-publication-binding:sha256:" + "d"*64 + " -->"}
        class Network:
            calls = 0
            def draft(self, c, token, deadline=None):
                qa.require(deadline is not None)
                self.calls += 1
                trace.append("draft")
                return None if self.calls == 1 else bound
            def get(self, path, token, deadline=None):
                qa.require(deadline is not None)
                trace.append("empty-assets")
                return []
        with patch.object(interruption, "bounded_command", return_value=["/cli"]), patch.object(interruption, "Gate", FakeGate), patch.object(
            interruption.subprocess, "Popen", return_value=Process()
        ):
            release_id = interruption.interrupt(Path("/cli"), [], Path("/scratch"),
                "private-token", Network(), c, "d"*64, qa.cli_env, qa.require)
        self.assertEqual(release_id, 123)
        self.assertEqual(trace, ["draft", "draft", "empty-assets", "terminate-owned", "wait-owned"])

    def test_interruption_requires_publish_and_namespaced_tag(self):
        with self.assertRaises(qa.Rejected):
            qa.qualify(Path("/not-executed"), candidate(), False, interrupt_draft=True)
        bad = {**candidate(), "tag": "qa-author-cli-hyphen-only"}
        data = json.dumps(bad).encode()
        with self.assertRaises(qa.Rejected):
            qa.load_candidate(data, qa.digest(data))

    def test_identity_requires_exact_tracked_source_fixture(self):
        import base64
        c = candidate()
        theme = (Path(__file__).parent / "theme.json").read_bytes()
        trace = []
        def get(path, token=None):
            trace.append(path)
            if path == "/repos/" + qa.REPOSITORY:
                return dict(id=qa.REPOSITORY_ID, private=False, full_name=qa.REPOSITORY)
            if "/commits/" in path:
                return {"sha": c["source_commit"]}
            if "/contents/" in path:
                return dict(type="file", encoding="base64", size=len(theme),
                            content=base64.b64encode(theme).decode())
            return {"login": c["expected_account"]}
        network = qa.GitHub()
        with patch.object(network, "get", side_effect=get):
            network.identity(c, "author-token")
        self.assertEqual(trace, ["/repos/" + qa.REPOSITORY,
            "/repos/" + qa.REPOSITORY + "/commits/qa-author-cli%2Ffixture-001",
            "/repos/" + qa.REPOSITORY +
            "/contents/scripts/author-cli-qa/theme.json?ref=" + c["source_commit"], "/user"])
        def mismatch(path, token=None):
            value = get(path, token)
            if "/contents/" in path:
                value["content"] = base64.b64encode(b"wrong").decode()
            return value
        with patch.object(network, "get", side_effect=mismatch), self.assertRaises(qa.Rejected):
            network.identity(c, "author-token")

    def test_negative_probe_requires_exact_structured_failure(self):
        expected = "request SHA-256 confirmation does not match"
        cases = [
            (1, {"ok": False, "code": "AUTHOR_RELEASE_FAILED", "message": expected}, True),
            (-9, {"ok": False, "code": "AUTHOR_RELEASE_FAILED", "message": expected}, False),
            (1, {"ok": False, "code": "AUTHOR_RELEASE_FAILED",
                 "message": "CADENCR_AUTHOR_GITHUB_TOKEN is required"}, False),
            (2, {"ok": False, "code": "CLI_USAGE_ERROR", "message": expected}, False),
            (1, {"ok": False, "code": "AUTHOR_RELEASE_FAILED",
                 "message": "author release local validation failed"}, False),
        ]
        for code, diagnostic, accepted in cases:
            def run(command, **kwargs):
                self.assertNotIn("preexec_fn", kwargs)
                kwargs["stderr"].write(json.dumps(diagnostic).encode())
                return type("Result", (), {"returncode": code})()
            with self.subTest(code=code, diagnostic=diagnostic), patch.object(
                qa, "bounded_command", return_value=["/usr/bin/prlimit", "--", "/cli"]
            ), patch.object(qa.subprocess, "run", side_effect=run):
                if accepted:
                    qa.invoke(Path("/cli"), [], Path("/scratch"), success=False,
                              expected_error=expected)
                else:
                    with self.assertRaises(qa.Rejected):
                        qa.invoke(Path("/cli"), [], Path("/scratch"), success=False,
                                  expected_error=expected)

    def test_valid_json_returned_after_deadline_is_rejected(self):
        network = qa.GitHub()
        network.deadline = 10
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, limit):
                clock[0] = 11
                return b'{"ok":true}'
        class Opener:
            def open(self, request, timeout):
                return Response()
        network.opener = Opener()
        clock = [1]
        with patch.object(qa.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaises(qa.Rejected):
            network.get("/repos/" + qa.REPOSITORY)

    def test_operation_cannot_accept_overdeadline_mocked_pagination(self):
        network = qa.GitHub()
        previous = network.deadline
        clock = [1]
        def get(path, token=None):
            clock[0] = 32
            return []
        with patch.object(qa.time, "monotonic", side_effect=lambda: clock[0]), patch.object(
            network, "get", side_effect=get
        ), self.assertRaises(qa.Rejected):
            network.draft(candidate(), "private-token")
        self.assertEqual(network.deadline, previous)

    def test_prlimit_exec_wrapper_has_no_shell_or_fork_callback(self):
        from process_limits import bounded_command
        with patch.object(Path, "is_file", return_value=True):
            self.assertEqual(bounded_command(Path("/reviewed/cli"), ["--version"], 1024),
                             ["/usr/bin/prlimit", "--fsize=1024:1024", "--",
                              "/reviewed/cli", "--version"])

    def test_enclosing_deadline_caps_nested_network_timeout(self):
        for now, deadline in ((29, 30), (59, 60)):
            network = qa.GitHub()
            timeouts = []
            class Response:
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    pass
                data = b'{}'
                def read(self, limit):
                    data, self.data = self.data, b""
                    return data
            class Opener:
                def open(self, request, timeout):
                    timeouts.append(timeout)
                    return Response()
            network.opener = Opener()
            with patch.object(qa.time, "monotonic", return_value=now):
                network.get("/repos/" + qa.REPOSITORY, deadline=deadline)
            self.assertEqual(timeouts, [1])

    def test_candidate_exact_shape_identity_and_pin(self):
        c = candidate()
        data = json.dumps(c).encode()
        self.assertEqual(qa.load_candidate(data, qa.digest(data)), c)
        with self.assertRaises(qa.Rejected):
            qa.load_candidate(data, "0"*64)
        for field, value in [("repository", "CadencR/registry"), ("repository_id", True),
                             ("public", False), ("source_commit", "main"),
                             ("tag", "v1"), ("cli_sha256", "bad"),
                             ("expected_account", "user/other"), ("cli_version", 123),
                             ("unexpected", "secret")]:
            bad = {**c, field: value}
            data = json.dumps(bad).encode()
            with self.subTest(field=field), self.assertRaises(qa.Rejected):
                qa.load_candidate(data, qa.digest(data))

    def test_environment_cannot_inherit_credentials_or_proxy(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "actions-secret", "GH_TOKEN": "other",
                                    "HTTPS_PROXY": "https://bad", "HOME": "/private/user"}):
            env = qa.cli_env(Path("/scratch"))
            self.assertEqual(set(env), {"PATH", "HOME", "XDG_CONFIG_HOME", "LANG"})
            self.assertNotIn("secret", json.dumps(env))
            self.assertEqual(qa.cli_env(Path("/scratch"), "author")[
                "CADENCR_AUTHOR_GITHUB_TOKEN"], "author")

    def test_script_or_wrong_pin_is_not_a_distributed_cli(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "cli"
            p.write_bytes(b"#!/bin/sh\necho cadencr 1.2.3")
            c = {**candidate(), "cli_sha256": qa.digest(p.read_bytes())}
            with self.assertRaises(qa.Rejected):
                qa.check_cli(p, c)

    def test_api_paths_are_fixed_and_never_write(self):
        network = qa.GitHub()
        for path in ("/repos/CadencR/registry", "/user?token=secret", "https://bad"):
            with self.assertRaises(qa.Rejected):
                network.get(path)
        seen = []

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            sent = False
            def read(self, limit):
                if self.sent:
                    return b""
                self.sent = True
                return b'{"id":1420296872}'

        class Opener:
            def open(self, request, timeout):
                seen.append((request.get_method(), request.full_url, dict(request.header_items())))
                return Response()
        network.opener = Opener()
        network.get("/repos/" + qa.REPOSITORY)
        self.assertEqual(seen, [("GET", "https://api.github.com/repos/" + qa.REPOSITORY,
                               {"Accept": "application/vnd.github+json",
                                "User-agent": "cadencr-author-cli-qa"})])

    def test_completed_retry_trace_and_allowlisted_proof(self):
        trace = []
        with tempfile.TemporaryDirectory() as root:
            p = Path(root)
            home, stage = p / "home", p / "stage"
            home.mkdir()
            stage.mkdir()
            request = stage / "request.json"
            request.write_bytes(b'{}')
            (stage / "theme.tar.gz").write_bytes(b"archive")
            assets = {"theme.tar.gz": qa.asset(stage / "theme.tar.gz")}
            inventory = {"release_id": 1, "assets": [{"id": 2, **assets["theme.tar.gz"]}]}

            class Network:
                count = 0
                def identity(self, c, token):
                    trace.append("identity")
                def inventory(self, c, a, deadline=None):
                    trace.append("inventory")
                    self.count += 1
                    return None if self.count == 1 else inventory

            calls = []
            def invoke(cli, args, home, token=None, success=True, expected_error=None):
                calls.append((list(args), str(home), token, success))
                trace.append("publish" if success else "reject")
                return json.dumps(dict(ok=True, request_sha256="d"*64,
                                       already_published=len(calls) > 1)).encode()

            with patch.object(qa, "check_cli"), patch.object(
                qa, "local", return_value=(home, stage, request, "d"*64, assets)
            ), patch.object(qa, "invoke", side_effect=invoke), patch.dict(
                os.environ, {"QA_AUTHOR_GITHUB_TOKEN": "private-author-secret"}, clear=True
            ):
                proof = qa.qualify(Path("/reviewed/cli"), candidate(), True, Network())
            self.assertEqual(trace, ["identity", "inventory", "publish", "inventory",
                                    "publish", "inventory", "publish", "inventory",
                                    "reject", "inventory", "reject", "inventory"])
            self.assertNotEqual(calls[1][1], calls[2][1])
            self.assertEqual(proof["completed_retries"], 2)
            self.assertEqual(proof["interrupted_draft"], "not_exercised")
            serialized = json.dumps(proof)
            for secret in ("private-author-secret", "/scratch", "/reviewed", str(p)):
                self.assertNotIn(secret, serialized)

    def test_actions_token_cannot_be_author_token(self):
        with tempfile.TemporaryDirectory() as root, patch.object(
            qa, "check_cli"
        ), patch.object(qa, "local", return_value=(
            Path(root), Path(root), Path(root)/"r", "d"*64, {}
        )), patch.dict(os.environ, {
            "QA_AUTHOR_GITHUB_TOKEN": "same-token", "GITHUB_TOKEN": "same-token"
        }, clear=True), self.assertRaises(qa.Rejected):
            qa.qualify(Path("/cli"), candidate(), True)


if __name__ == "__main__":
    unittest.main()

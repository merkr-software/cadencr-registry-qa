"""Real stdio LSP smoke of the complete upstream bundle, without npm."""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import tempfile
import threading
import time

from common import clean_environment, invoke, process_limits, require, write_json


class Connection:
    def __init__(self, process):
        self.process = process
        self.messages = queue.Queue(maxsize=256)
        self.received = []
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            while True:
                headers = {}
                total = 0
                while True:
                    line = self.process.stdout.readline(8193)
                    if not line:
                        return
                    total += len(line)
                    require(total <= 16384, "LSP header exceeds bound")
                    if line == b"\r\n":
                        break
                    key, value = line.decode().split(":", 1)
                    require(key.lower() not in headers, "duplicate LSP header")
                    headers[key.lower()] = value.strip()
                size = int(headers["content-length"])
                require(0 < size <= 1024 * 1024, "LSP frame exceeds bound")
                data = self.process.stdout.read(size)
                require(len(data) == size, "truncated LSP frame")
                self.messages.put(json.loads(data), timeout=1)
        except Exception as error:
            # Propagate reader failures to the waiting main thread.
            self.messages.put({"reader_error": str(error)}, timeout=1)

    def send(self, value):
        data = json.dumps(value, separators=(",", ":")).encode()
        self.process.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
        self.process.stdin.flush()

    def wait(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                break
            require("reader_error" not in message, "LSP reader failed")
            require(len(self.received) < 256, "too many LSP messages")
            self.received.append(message)
            if "id" in message and "method" in message:
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": None})
            if predicate(message):
                return message
        raise RuntimeError("timed out waiting for LSP response")


def exercise(connection, workspace, file, source):
    connection.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "processId": None, "rootUri": workspace.as_uri(),
        "workspaceFolders": [{"uri": workspace.as_uri(), "name": "seed-smoke"}],
        "capabilities": {"textDocument": {"publishDiagnostics": {}}},
        "initializationOptions": {"disableAutomaticTypingAcquisition": True,
                                  "tsserver": {"useSyntaxServer": "never"}}}})
    initialized = connection.wait(lambda m: m.get("id") == 1)
    require(initialized.get("result", {}).get("capabilities", {}).get("hoverProvider"), "initialize failed")
    connection.send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
    connection.send({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
        "textDocument": {"uri": file.as_uri(), "languageId": "typescript", "version": 1, "text": source}}})
    diagnostic = connection.wait(lambda m: m.get("method") == "textDocument/publishDiagnostics"
        and any(d.get("code") == 2322 for d in m.get("params", {}).get("diagnostics", [])))
    connection.send({"jsonrpc": "2.0", "id": 2, "method": "textDocument/hover", "params": {
        "textDocument": {"uri": file.as_uri()}, "position": {"line": 1, "character": 2}}})
    hover = connection.wait(lambda m: m.get("id") == 2)
    require("const answer: string" in json.dumps(hover.get("result")), "incorrect hover")
    bundled = [m["params"] for m in connection.received if m.get("method") == "$/typescriptVersion"]
    require({"version": "6.0.3", "source": "bundled"} in bundled, "bundled TypeScript was not selected")
    connection.send({"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": None})
    require("error" not in connection.wait(lambda m: m.get("id") == 3), "shutdown failed")
    connection.send({"jsonrpc": "2.0", "method": "exit", "params": None})
    return {"bundled_typescript": bundled, "diagnostic_codes": [d["code"] for d in
            diagnostic["params"]["diagnostics"]], "hover": hover["result"]}


def run_smoke(bundle, node, work, evidence):
    workspace = work / "workspace"
    workspace.mkdir()
    (workspace / "tsconfig.json").write_text('{"compilerOptions":{"strict":true,"noEmit":true}}\n')
    source = "const answer: string = 42;\nanswer;\n"
    file = workspace / "example.ts"
    file.write_text(source)
    home = work / "smoke-home"
    home.mkdir()
    env = clean_environment(home, node)
    version, stderr = invoke([node, "--version"], home, env)
    require(version.strip() == b"v22.19.0" and stderr == b"", "exact Node22.19.0 required")
    upstream, stderr = invoke([node, bundle / "lib/cli.mjs", "--version"], home, env)
    require(upstream.strip() == b"5.3.0" and stderr == b"", "wrong upstream server version")
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen([str(node), str(bundle / "lib/cli.mjs"), "--stdio"],
            cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=errors, start_new_session=True, preexec_fn=process_limits)
        try:
            result = exercise(Connection(process), workspace, file, source)
            process.wait(timeout=10)
            require(process.returncode == 0 and errors.tell() <= 1024 * 1024, "LSP exit or stderr bound")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
            process.stdin.close()
            process.stdout.close()
    result.update({"schema_version": 1, "status": "passed", "node": "22.19.0",
        "upstream_server": "5.3.0", "platform": os.uname().sysname + "/" + os.uname().machine,
        "checks": ["initialize", "bundled-TypeScript6.0.3", "semantic-TS2322", "hover", "shutdown-exit0"],
        "scope": "upstream stdio runtime only; no app UI/install/revocation or cross-platform runtime claim"})
    write_json(evidence, result)
    return result

"""Bounded local I/O shared by the held Node seed preparation tools."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import resource
import subprocess
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path and path.is_file()
            and not path.is_symlink() and path.stat().st_size <= limit, "unsafe input: " + path.name)
    return path.read_bytes()


def relative(name):
    path = PurePosixPath(name)
    require(isinstance(name, str) and name and str(path) == name and not path.is_absolute()
            and all(part not in ("", ".", "..") and not part.startswith(".") for part in path.parts)
            and "\\" not in name and name.isascii(), "unsafe payload path")
    return path


def new_directory(path):
    path = Path(path)
    require(path.is_absolute() and not path.exists() and not path.is_symlink()
            and path.parent.resolve() == path.parent and path.parent.is_dir(), "new canonical directory required")
    path.mkdir(mode=0o700)
    return path


def write_json(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")


def process_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def invoke(command, cwd, env, timeout=90):
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        completed = subprocess.run(list(map(str, command)), cwd=cwd, env=env,
            stdout=out, stderr=err, timeout=timeout, preexec_fn=process_limits)
        require(out.tell() <= 1024 * 1024 and err.tell() <= 1024 * 1024, "process output exceeds bound")
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(), err.read()
    require(completed.returncode == 0, "operation failed: " + str(command[0]) +
            " (exit " + str(completed.returncode) + "): " + stderr[:2048].decode(errors="replace"))
    return stdout, stderr


def clean_environment(home, node):
    return {"PATH": str(Path(node).parent) + ":/usr/bin:/bin", "HOME": str(home),
            "TMPDIR": str(home), "LANG": "C.UTF-8"}

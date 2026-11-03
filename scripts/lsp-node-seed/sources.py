"""Download exact npm payload bytes, then extract only locked regular files."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

from common import digest, new_directory, regular, relative, require, write_json

EXPECTED = {"typescript-language-server": ("5.3.0", "."),
            "typescript": ("6.0.3", "node_modules/typescript")}


def load_lock(path):
    raw = regular(path, 128 * 1024)
    lock = json.loads(raw)
    require(set(lock) == {"schema_version", "package_version", "min_app_version", "node_version", "sources"}
            and lock["schema_version"] == 1 and lock["package_version"] == "0.1.0"
            and lock["min_app_version"] == "0.16.1" and lock["node_version"] == "22.19.0",
            "unexpected seed lock identity")
    require(isinstance(lock["sources"], list) and len(lock["sources"]) == 2, "two locked sources required")
    require({s["name"] for s in lock["sources"]} == set(EXPECTED), "unexpected source names")
    for source in lock["sources"]:
        name = source["name"]
        require((source["version"], source["destination"]) == EXPECTED[name], "unexpected source version")
        require(source["tarball"] == f"https://registry.npmjs.org/{name}/-/{name}-{source['version']}.tgz",
                "unexpected source origin")
        require(re.fullmatch("[a-f0-9]{64}", source["sha256"])
                and re.fullmatch("[a-f0-9]{40}", source["commit"])
                and 0 < source["size"] <= 8 * 1024 * 1024
                and 0 < source["expanded_size"] <= 64 * 1024 * 1024, "invalid source bounds")
        require(len(source["files"]) <= 4096 and len({f["path"] for f in source["files"]})
                == len(source["files"]), "invalid locked file inventory")
        for file in source["files"]:
            relative(file["path"])
            require(set(file) == {"path", "sha256", "size"}
                    and re.fullmatch("[a-f0-9]{64}", file["sha256"])
                    and isinstance(file["size"], int) and 0 <= file["size"] <= 32 * 1024 * 1024,
                    "invalid locked file")
        require(sum(f["size"] for f in source["files"]) == source["expanded_size"], "expanded bound mismatch")
    return raw, lock


def verify_tarball(data, source):
    expected = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    require(len(data) == source["size"] and digest(data) == source["sha256"]
            and expected == source["integrity"], "upstream tarball integrity mismatch")


def extract_locked(data, source, destination):
    verify_tarball(data, source)
    expected = {f["path"]: f for f in source["files"]}
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            require(member.isfile() and not member.linkname and not member.issparse()
                    and member.name.startswith("package/"), "non-regular npm member")
            name = member.name.removeprefix("package/")
            relative(name)
            require(name in expected and name not in seen, "extra or duplicate npm member")
            spec = expected[name]
            require(member.size == spec["size"], "npm file size mismatch")
            content = archive.extractfile(member).read(member.size + 1)
            require(len(content) == member.size and digest(content) == spec["sha256"], "npm file digest mismatch")
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(content)
            path.chmod(0o644)
            seen.add(name)
    require(seen == set(expected), "missing npm members")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise RuntimeError("npm redirect refused")


def download(source):
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(source["tarball"], headers={"User-Agent": "Cadencr-held-LSP-seed/1"})
    with opener.open(request, timeout=45) as response:
        require(response.status == 200 and response.url == source["tarball"], "unexpected npm response")
        data = response.read(source["size"] + 1)
    verify_tarball(data, source)
    return data


def prepare(lock_path, output):
    raw, lock = load_lock(lock_path)
    output = new_directory(output)
    bundle = output / "bundle"
    bundle.mkdir()
    downloads = output / "downloads"
    downloads.mkdir()
    for source in lock["sources"]:
        data = download(source)
        (downloads / (source["name"] + ".tgz")).write_bytes(data)
        destination = bundle if source["destination"] == "." else bundle / source["destination"]
        destination.mkdir(parents=True, exist_ok=True)
        extract_locked(data, source, destination)
    (output / "source-lock.json").write_bytes(raw)
    write_json(output / "acquisition.json", {"schema_version": 1, "source_lock_sha256": digest(raw),
        "integrity": "exact SHA512 npm and SHA256 plus every locked file verified",
        "sources": [{k: s[k] for k in ("name", "version", "commit", "sha256", "integrity", "size")}
                    for s in lock["sources"]], "installers_or_scripts_executed": False})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.lock, args.output)

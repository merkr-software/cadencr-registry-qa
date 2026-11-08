"""Public LSP plan projection only; never exports the source submission or scratch."""
import copy
import json
from pathlib import Path
import re
import urllib.parse
from failure_diagnostics import require
from packages import metadata, TARGETS


def document(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 * 1024)
    return json.loads(path.read_bytes())


def public_url(value, prefix):
    require(type(value) is str)
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == "https" and parsed.netloc == "github.com"
            and parsed.username is None and parsed.password is None
            and not parsed.query and not parsed.fragment and value.startswith(prefix))


def registry_plan(root, candidate):
    """Retain the actual Rust JSON insertion order, after binding every public field."""
    repository = "https://github.com/" + candidate["repository"]
    require(candidate["repository"] == "merkr-software/cadencr-registry-qa")
    plan = document(root / "plan.json")
    source = document(root / "stage/metadata.json")
    require(plan["schema_version"] == 2 and plan["repository"] == candidate["repository"])
    expected = metadata("lsp", candidate["repository"], candidate["tag"],
                        lsp_version={"0.15.6": "1.0.1", "0.15.7": "1.0.2"}.get(candidate["cli_version"], "1.0.0"))
    descriptor = source["package"]["lsp"]
    require(set(source) == {"kind", "package"} and source["kind"] == "lsp"
            and set(source["package"]) == {"lsp", "host"}
            and source["package"]["host"] == expected["package"]["host"]
            and {k: v for k, v in descriptor.items() if k != "distribution"}
            == {k: v for k, v in expected["package"]["lsp"].items() if k != "distribution"})
    release = plan["release"]["tag"]
    require(release == "lsp-" + descriptor["id"] + "-v" + descriptor["version"])
    source_targets = descriptor["distribution"]["binary"]
    require(set(descriptor["distribution"]) == {"binary"} and set(source_targets) == set(TARGETS))
    source_prefix = repository + "/releases/download/" + urllib.parse.quote(candidate["tag"], safe="") + "/"
    destination_prefix = repository + "/releases/download/" + release + "/"
    mirrored = copy.deepcopy(source)
    require(type(plan["targets"]) is list and len(plan["targets"]) == len(TARGETS))
    seen = set()
    for target in plan["targets"]:
        require(set(target) == {"target", "asset", "source_url", "destination_url", "sha256"})
        platform = target["target"]
        require(platform in TARGETS and platform not in seen)
        seen.add(platform)
        original = source_targets[platform]
        require(set(original) == {"archive", "sha256", "size", "entry", "entry_sha256", "entry_size", "runtime"})
        require(target["source_url"] == original["archive"] and target["sha256"] == original["sha256"])
        public_url(target["source_url"], source_prefix)
        require(type(target["asset"]) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,239}", target["asset"]))
        require(target["asset"] == platform + "-" + original["sha256"] + ".tar.gz")
        require(target["destination_url"] == destination_prefix + target["asset"])
        public_url(target["destination_url"], destination_prefix)
        for field in ("sha256", "entry_sha256"):
            require(type(original[field]) is str and re.fullmatch(r"[a-f0-9]{64}", original[field]))
        require(original["entry"] == "server.js" and original["runtime"] == "node"
                and type(original["size"]) is int and 0 < original["size"] <= 64 * 1024 * 1024
                and type(original["entry_size"]) is int and 0 < original["entry_size"] <= 256 * 1024 * 1024)
        mirrored["package"]["lsp"]["distribution"]["binary"][platform]["archive"] = target["destination_url"]
    mirrored["package"]["lsp"]["distribution"]["repository"] = repository
    require(plan["mirrored_package"] == mirrored)
    # Never export plan.source, unknown root fields, paths, credentials or raw scratch.
    return {"release_tag": release, "mirrored_package": plan["mirrored_package"], "targets": plan["targets"]}

"""Explicit local source-CLI check; never claims released-ELF qualification."""
import argparse
import json
import os
from pathlib import Path

from common import clean_environment, digest, invoke, new_directory, regular, require, write_json
from prepare import build
from sources import extract_locked, load_lock


def run(args):
    os.umask(0o077)
    raw, lock = load_lock(args.lock)
    root = new_directory(args.output)
    sources = root / "sources"
    sources.mkdir()
    bundle = sources / "bundle"
    bundle.mkdir()
    for source in lock["sources"]:
        archive = args.tarballs / (source["name"] + "-" + source["version"] + ".tgz")
        data = regular(archive, 8 * 1024 * 1024)
        destination = bundle if source["destination"] == "." else bundle / source["destination"]
        destination.mkdir(parents=True, exist_ok=True)
        extract_locked(data, source, destination)
    work, output = root / "private", root / "artifacts"
    work.mkdir()
    output.mkdir()
    home = work / "home"
    home.mkdir()
    env = clean_environment(home, args.node)
    version, stderr = invoke([args.cli, "--version"], work, env)
    require(version.strip() == b"cadencr 0.15.5" and stderr == b"", "source CLI0.15.5 required")
    result = build(args.cli, args.node, sources, work, output, lock, env)
    result.update({"schema_version": 1, "status": "passed-local-source-only",
        "scope": "local prepared-source and source-built CLI checks; not distributed ELF qualification",
        "source_lock_sha256": digest(raw), "cli_sha256": digest(regular(args.cli, 128 * 1024 * 1024)),
        "publication_not_requested": True, "production_unchanged": True, "planned_release_not_created": True})
    result["platform_limit"] = "Only this local host runtime exercised; Linux distributed ELF remains unqualified."
    write_json(output / "local-evidence.json", result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cli", "node", "lock", "tarballs", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    run(parser.parse_args())

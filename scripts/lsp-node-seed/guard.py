"""Fail closed before network acquisition unless every reviewed input matches."""
import hashlib
import os
from pathlib import Path
import re

from common import regular, require
from sources import load_lock


def guard():
    repository = "merkr-software/cadencr-registry-qa"
    exact = {"GITHUB_REPOSITORY": repository, "GITHUB_REPOSITORY_ID": "1420296872",
        "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_WORKFLOW_REF": repository + "/.github/workflows/lsp-node-seed.yml@refs/heads/main"}
    require(all(os.environ.get(key) == value for key, value in exact.items()), "untrusted dispatch context")
    reviewed = os.environ["REVIEWED_COMMIT"]
    require(re.fullmatch("[a-f0-9]{40}", reviewed) and os.environ.get("GITHUB_SHA") == reviewed,
            "reviewed commit mismatch")
    for env, path in [("PINS_SHA256", "lsp-cli-pin.env"),
                      ("SOURCE_LOCK_SHA256", "scripts/lsp-node-seed/source-lock.json")]:
        expected = os.environ[env]
        require(re.fullmatch("[a-f0-9]{64}", expected), "invalid reviewed digest")
        raw = regular(Path(path).resolve(), 128 * 1024 if env == "SOURCE_LOCK_SHA256" else 1024)
        require(hashlib.sha256(raw).hexdigest() == expected, "reviewed input digest mismatch")
    pins = regular(Path("lsp-cli-pin.env").absolute(), 1024).decode().splitlines()
    require(len(pins) == 3 and pins[0] == "CADENCR_RELEASE_VERSION=0.15.5"
            and pins[1] == "CADENCR_RELEASE_TAG=cli/v0.15.5"
            and re.fullmatch("CADENCR_RELEASE_SHA256=[a-f0-9]{64}", pins[2]), "unexpected released CLI pins")
    load_lock(Path("scripts/lsp-node-seed/source-lock.json").absolute())


if __name__ == "__main__":
    guard()

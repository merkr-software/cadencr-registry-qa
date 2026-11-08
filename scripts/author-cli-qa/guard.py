"""Read-only guard for the reviewed QA workflow, never publication authority."""
import os
from pathlib import Path
import re
import runpy
import sys


def require(condition):
    if not condition:
        raise ValueError("QA dispatch or pin mismatch")


def main():
    try:
        expected = "merkr-software/cadencr-registry-qa"
        require(os.environ.get("GITHUB_REPOSITORY") == expected)
        require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch")
        require(os.environ.get("GITHUB_REF") == "refs/heads/main")
        sha = os.environ.get("GITHUB_SHA", "")
        require(re.fullmatch("[0-9a-f]{40}", sha))
        require(os.environ.get("REVIEWED_COMMIT") == sha)
        workflow = os.environ.get("GITHUB_WORKFLOW_REF")
        profile_id = next((name for name in ("cli0156", "cli0157") if workflow == expected + "/.github/workflows/" + name + "-author.yml@refs/heads/main"), None)
        modern = profile_id is not None
        require(modern or workflow == expected + "/.github/workflows/author.yml@refs/heads/main")
        root = Path(__file__).resolve().parents[2]
        if modern:
            sys.path.insert(0, str(root / "scripts" / profile_id))
            profile_guard = runpy.run_path(str(root / "scripts" / profile_id / "guard.py"))
            profile = profile_guard["guard"]()
        candidate = root / ("requests/" + profile_id + "/author-candidate.json" if modern else "author-cli-candidate.json")
        require(candidate.is_file() and not candidate.is_symlink())
        require(candidate.stat().st_size <= 65536)
        harness = runpy.run_path(str(root / "scripts/qualify-author-cli.py"))
        c = harness["load_candidate"](candidate.read_bytes(), os.environ["CANDIDATE_SHA256"])
        if modern:
            require(c["cli_version"] == profile["version"] and c["cli_sha256"] == profile["cli_sha256"])
        pin = root / ("requests/" + profile_id + "/released-cli.env" if modern else "author-cli-pin.env")
        require(pin.is_file() and not pin.is_symlink() and pin.stat().st_size <= 4096)
        values = {}
        for line in pin.read_text().splitlines():
            if not line or line.startswith("#"):
                continue
            key, value = line.split("=", 1)
            require(key not in values)
            values[key] = value
        require(values == {
            "CADENCR_RELEASE_VERSION": c["cli_version"],
            "CADENCR_RELEASE_TAG": "cli/v" + c["cli_version"],
            "CADENCR_RELEASE_SHA256": c["cli_sha256"],
        })
    except Exception:
        print("AUTHOR_QA_CONTEXT_OR_PIN_REJECTED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

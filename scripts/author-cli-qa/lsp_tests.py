"""LSP harness tests; synthetic checks and optional source-built CLI smoke only."""
import importlib.util
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("lsp_qualification", ROOT.parent / "qualify-author-cli.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
import packages


def candidate():
    return dict(kind="lsp", cli_version="0.15.5", cli_sha256="b" * 64,
        repository=qa.REPOSITORY, repository_id=qa.REPOSITORY_ID, public=True,
        expected_account="qa-author", tag="qa-author-cli/stable-0155-lsp-test",
        source_commit="a" * 40)


def receipt(args):
    source = Path(args[args.index("--directory") + 1])
    output = Path(args[args.index("--output") + 1])
    target = args[args.index("--target") + 1]
    entry = args[args.index("--entry") + 1]
    output.write_bytes(b"inert archive " + target.encode())
    archive = qa.asset(output)
    data = (source / entry).read_bytes()
    return dict(kind="lsp", target=target, archive=str(output.absolute()),
        sha256=archive["sha256"], size=archive["size"], entry=entry,
        entry_sha256=qa.digest(data), entry_size=len(data), runtime="node")


def plan_fixture(root):
    source = packages.metadata("lsp", qa.REPOSITORY, candidate()["tag"])
    release = "lsp-qa-author-lsp-v1.0.0"
    mirrored = copy.deepcopy(source)
    targets = []
    for target in packages.TARGETS:
        original = source["package"]["lsp"]["distribution"]["binary"][target]
        original.update(sha256="a" * 64, size=81, entry="server.js",
                        entry_sha256="b" * 64, entry_size=71, runtime="node")
        asset = target + "-" + original["sha256"] + ".tar.gz"
        destination = "https://github.com/" + qa.REPOSITORY + "/releases/download/" + release + "/" + asset
        targets.append(dict(target=target, asset=asset, source_url=original["archive"],
                            destination_url=destination, sha256=original["sha256"]))
        mirrored["package"]["lsp"]["distribution"]["binary"][target] = {**original, "archive": destination}
    mirrored["package"]["lsp"]["distribution"]["repository"] = "https://github.com/" + qa.REPOSITORY
    # Deliberate Rust-style ordering variation to catch recursive proof re-sorting.
    mirrored = {"package": mirrored["package"], "kind": mirrored["kind"]}
    plan = dict(schema_version=2, repository=qa.REPOSITORY, release={"tag": release},
                source={"private_path": "/private/scratch-not-exported"},
                mirrored_package=mirrored, targets=targets)
    (root / "stage").mkdir()
    packages.write_json(root / "stage/metadata.json", source)
    packages.write_json(root / "plan.json", plan)
    return plan, source


class LspTests(unittest.TestCase):
    def test_lsp_plan_projection_exports_only_public_bound_fields(self):
        from lsp_plan import registry_plan
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            plan, _ = plan_fixture(root)
            # Preserve the order delivered by the actual plan parser.
            (root / "plan.json").write_text(json.dumps(plan))
            projection = registry_plan(root, candidate())
            self.assertEqual(set(projection), {"release_tag", "mirrored_package", "targets"})
            self.assertEqual(projection["release_tag"], plan["release"]["tag"])
            self.assertEqual(projection["targets"], plan["targets"])
            self.assertEqual(list(projection["mirrored_package"]), ["package", "kind"])
            self.assertNotIn("private_path", json.dumps(projection))
            self.assertNotIn("/private/", json.dumps(projection))

    def test_lsp_plan_projection_refuses_private_fields_credentials_and_binding_changes(self):
        from lsp_plan import registry_plan
        for change in (
            lambda p: p.update(release={"tag": "/private/scratch"}),
            lambda p: p["targets"][0].update(private_path="/private/scratch"),
            lambda p: p["targets"][0].update(source_url="file:///private/scratch"),
            lambda p: p["targets"][0].update(source_url="https://token@github.com/qa/private"),
            lambda p: p["targets"][0].update(destination_url=p["targets"][0]["destination_url"] + "?token=secret"),
            lambda p: p["targets"][0].update(sha256="f" * 64),
            lambda p: p["mirrored_package"]["package"]["lsp"].update(args=["/private/scratch"]),
            lambda p: p["mirrored_package"]["package"]["lsp"].update(initialization_options={"token": "secret"}),
            lambda p: p["targets"].pop(),
        ):
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                plan, _ = plan_fixture(root)
                change(plan)
                packages.write_json(root / "plan.json", plan)
                with self.assertRaises(qa.Rejected):
                    registry_plan(root, candidate())

    def test_lsp_proof_writer_preserves_plan_order_and_legacy_sorting(self):
        for kind, ordered in (("lsp", ["package", "kind"]), ("theme", ["kind", "package"])):
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                c = {**candidate(), "kind": kind}
                path = root / "candidate.json"
                packages.write_json(path, c)
                output = root / "proof.json"
                proof = {"registry_plan": {"mirrored_package": {"package": {}, "kind": "lsp"}}}
                args = ["qa", "--candidate", str(path), "--confirm-candidate-sha256", qa.digest(path.read_bytes()),
                        "--cli", "/not-executed", "--output", str(output)]
                with patch.object(sys, "argv", args), patch.object(qa, "qualify", return_value=proof):
                    self.assertEqual(qa.main(), 0)
                self.assertEqual(list(json.loads(output.read_bytes())["registry_plan"]["mirrored_package"]), ordered)

    def test_lsp_candidate_keeps_exact_shape_repository_and_variant_guards(self):
        c = candidate()
        raw = json.dumps(c).encode()
        self.assertEqual(qa.load_candidate(raw, qa.digest(raw)), c)
        for field, value in (("tab_variant", "ui-only"), ("unexpected", True),
            ("repository", "other/repository"), ("repository_id", True),
            ("public", False), ("expected_account", "other/account"),
            ("source_commit", "main"), ("tag", "v1.0.0")):
            bad = json.dumps({**c, field: value}).encode()
            with self.subTest(field=field), self.assertRaises(qa.Rejected):
                qa.load_candidate(bad, qa.digest(bad))
        with self.assertRaises(qa.Rejected):
            qa.load_candidate(raw, "0" * 64)

    def test_lsp_preparation_binds_receipts_then_validates_and_plans_in_rust(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve()
            home = root / "home"
            home.mkdir()
            calls = []
            def invoke(cli, args, home):
                calls.append(args)
                if args[:2] == ["registry", "pack-lsp"]:
                    return json.dumps(receipt(args)).encode()
                if args[:3] == ["--json", "plugin", "validate"]:
                    metadata = json.loads((Path(args[3]) / "lsp.json").read_bytes())
                    self.assertEqual(set(metadata["package"]["lsp"]["distribution"]["binary"]),
                                     set(packages.TARGETS))
                if "--output" in args:
                    Path(args[args.index("--output") + 1]).write_bytes(b"inert plan")
                return b"{}"
            stage, archives = packages.prepare(Path("/released/cli"), candidate(), root,
                                               home, invoke, qa.asset)
            self.assertEqual([args[:2] for args in calls], [["registry", "pack-lsp"],
                ["registry", "pack-lsp"], ["--json", "plugin"],
                ["registry", "build-index"], ["registry", "plan-publication"]])
            self.assertEqual(calls[2][-2:], ["--kind", "lsp"])
            self.assertEqual(calls[3][calls[3].index("--schema-version") + 1], "2")
            metadata = json.loads((stage / "metadata.json").read_bytes())
            descriptor = metadata["package"]["lsp"]
            self.assertEqual(metadata["package"]["host"]["compatibility"]["min_app_version"], "999.0.0")
            self.assertEqual(descriptor["id"], "qa-author-lsp")
            self.assertEqual(descriptor["version"], "1.0.0")
            self.assertEqual(descriptor["protocol_version"], 1)
            self.assertEqual([a["name"] for a in archives],
                             ["lsp-" + target + ".tar.gz" for target in packages.TARGETS])
            for target, archive in zip(packages.TARGETS, archives):
                bound = descriptor["distribution"]["binary"][target]
                self.assertEqual(set(bound), {"archive", "sha256", "size", "entry",
                    "entry_sha256", "entry_size", "runtime"})
                self.assertEqual(bound["sha256"], archive["sha256"])
                self.assertEqual(bound["size"], archive["size"])
                self.assertEqual(bound["entry_sha256"], qa.digest((ROOT / "fixtures/lsp/server.js").read_bytes()))
                self.assertEqual(bound["runtime"], "node")
                self.assertIn("qa-author-cli%2Fstable-0155-lsp-test/", bound["archive"])
            self.assertEqual(set(p.name for p in stage.iterdir()),
                             {"metadata.json", *(a["name"] for a in archives)})
            submission = json.loads((root / "submission.json").read_bytes())
            self.assertEqual(submission["schema_version"], 2)
            self.assertEqual(submission["package"], metadata)
            self.assertEqual(submission["source"], {"repository": "https://github.com/" + qa.REPOSITORY,
                "tag": candidate()["tag"], "commit": candidate()["source_commit"]})

    def test_cli0156_prepares_a_new_version_without_reusing_the_0155_release(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve()
            home = root / "home"
            home.mkdir()
            c = {**candidate(), "cli_version": "0.15.6", "tag": "qa-author-cli/stable-0156-lsp-test"}
            def invoke(cli, args, home):
                if args[:2] == ["registry", "pack-lsp"]:
                    return json.dumps(receipt(args)).encode()
                if "--output" in args:
                    Path(args[args.index("--output") + 1]).write_bytes(b"inert plan")
                return b"{}"
            stage, archives = packages.prepare(Path("/released/cli"), c, root, home, invoke, qa.asset)
            metadata = json.loads((stage / "metadata.json").read_bytes())
            self.assertEqual(metadata["package"]["lsp"]["version"], "1.0.1")
            self.assertEqual(metadata["package"]["host"]["compatibility"]["min_app_version"], "999.0.0")
            self.assertEqual(len(archives), 2)
            self.assertEqual(packages.metadata("lsp", qa.REPOSITORY, candidate()["tag"])["package"]["lsp"]["version"], "1.0.0")

    def test_cli0157_uses_a_distinct_inert_version(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve()
            home = root / "home"
            home.mkdir()
            c = {**candidate(), "cli_version": "0.15.7", "tag": "qa-author-cli/stable-0157-lsp-test"}
            def invoke(cli, args, home):
                if args[:2] == ["registry", "pack-lsp"]:
                    return json.dumps(receipt(args)).encode()
                if "--output" in args:
                    Path(args[args.index("--output") + 1]).write_bytes(b"inert plan")
                return b"{}"
            stage, archives = packages.prepare(Path("/released/cli"), c, root, home, invoke, qa.asset)
            metadata = json.loads((stage / "metadata.json").read_bytes())
            self.assertEqual(metadata["package"]["lsp"]["version"], "1.0.2")
            self.assertEqual(len(archives), 2)
            for target in metadata["package"]["lsp"]["distribution"]["binary"].values():
                self.assertIn("qa-author-cli%2Fstable-0157-lsp-test/", target["archive"])

    def test_every_lsp_receipt_binding_is_required(self):
        for field in ("kind", "target", "archive", "sha256", "size", "entry", "entry_sha256",
                      "entry_size", "runtime", "unexpected", "missing"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch).resolve()
                home = root / "home"
                home.mkdir()
                def invoke(cli, args, home):
                    value = receipt(args)
                    if field == "missing":
                        value.pop("entry_sha256")
                    else:
                        value[field] = "changed receipt field"
                    return json.dumps(value).encode()
                with self.assertRaises(qa.Rejected):
                    packages.prepare(Path("/released/cli"), candidate(), root, home, invoke, qa.asset)

    def test_lsp_fixture_inventory_is_inert_and_bound(self):
        paths = packages.fixture_paths("lsp")
        self.assertEqual(paths, [ROOT / "fixtures/lsp/server.js"])
        self.assertIn("Never execute", paths[0].read_text())
        self.assertIn("throw new Error", paths[0].read_text())
        self.assertEqual(qa.source_inventory(candidate()), {
            "author-cli-qa/fixtures/lsp/server.js": qa.digest(paths[0].read_bytes())})

    @unittest.skipUnless(os.environ.get("CADENCR_DEVELOPMENT_FIXTURE_CLI"),
                         "explicit development CLI required; not released-CLI qualification")
    def test_development_lsp_author_request_and_all_changed_assets_reject_locally(self):
        from negative_probes import reject_changes
        cli = Path(os.environ["CADENCR_DEVELOPMENT_FIXTURE_CLI"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="author-lsp-development-") as scratch:
            root = Path(scratch).resolve()
            # macOS development lacks Linux prlimit; production ELF guards are unchanged.
            with patch.object(qa, "bounded_command", side_effect=lambda cli, args, limit:
                              [str(cli), *map(str, args)]):
                home, stage, request, sha, assets = qa.local(cli, candidate(), root)
                request_value = json.loads(request.read_bytes())
                self.assertEqual(request_value["archive"]["name"], "lsp-linux-x86_64.tar.gz")
                self.assertEqual([a["name"] for a in request_value["additional_archives"]],
                                 ["lsp-darwin-aarch64.tar.gz"])
                self.assertEqual(set(assets), {"metadata.json", "lsp-linux-x86_64.tar.gz",
                                               "lsp-darwin-aarch64.tar.gz"})
                other = root / "fresh"
                other.mkdir()
                _, _, fresh_request, fresh_sha, fresh_assets = qa.local(cli, candidate(), other)
                self.assertEqual(request.read_bytes(), fresh_request.read_bytes())
                self.assertEqual(sha, fresh_sha)
                self.assertEqual(assets, fresh_assets)
                plan = json.loads((root / "plan.json").read_bytes())
                self.assertEqual([p["target"] for p in plan["targets"]], list(packages.TARGETS[::-1]))
                projected_root = root / "qualification"
                projected_root.mkdir()
                with patch.object(qa, "check_cli"), patch.object(qa.tempfile, "mkdtemp", return_value=str(projected_root)):
                    proof = qa.qualify(cli, candidate(), False)
                actual_plan = json.loads((projected_root / "plan.json").read_bytes())
                self.assertEqual(proof["registry_plan"], {"release_tag": actual_plan["release"]["tag"],
                    "mirrored_package": actual_plan["mirrored_package"], "targets": actual_plan["targets"]})
                self.assertNotIn(str(root), json.dumps(proof))
                class Network:
                    checks = 0
                    def inventory(self, c, bound):
                        self.checks += 1
                        return "unchanged"
                network = Network()
                reject_changes(cli, home, stage, request, sha, None, network, candidate(), assets,
                               "unchanged", qa.invoke, qa.require)
                self.assertEqual(network.checks, len(assets) + 1)


if __name__ == "__main__":
    unittest.main()

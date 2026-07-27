from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.swe_pro import run_swe_pro as harness


class DatasetContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not harness.DEFAULT_CHECKOUT.is_dir():
            raise unittest.SkipTest("Pinned SWE-bench Pro checkout is unavailable")
        cls.checkout = harness.validate_checkout(harness.DEFAULT_CHECKOUT)
        cls.instances = harness.load_instances(
            cls.checkout / "helper_code/sweap_eval_full_v2.jsonl"
        )

    def test_audited_checkout_and_dataset_are_pinned(self) -> None:
        self.assertEqual(len(self.instances), 731)
        self.assertEqual(
            harness.sha256_file(
                self.checkout / "helper_code/sweap_eval_full_v2.jsonl"
            ),
            harness.EXPECTED_DATASET_SHA256,
        )

    def test_known_smoke_instance_contract(self) -> None:
        row = self.instances[harness.SMOKE_INSTANCE]
        self.assertEqual(row["repo"], "ansible/ansible")
        self.assertEqual(
            row["base_commit"],
            "4c8c40fd3d4a58defdc80e7d22aa8d26b731353e",
        )
        self.assertEqual(
            harness.dockerhub_image_uri(row),
            (
                "jefzda/sweap-images:"
                "ansible.ansible-ansible__ansible-"
                "9a21e247786ebd294dafafca1105fcd770ff46c6-"
                "v67cdaa49f89b34e42b69d5b7830b3c3ad3d8803f"
            ),
        )

    def test_all_image_uris_match_the_pinned_official_helper(self) -> None:
        helper_path = self.checkout / "helper_code/image_uri.py"
        spec = importlib.util.spec_from_file_location(
            "pinned_swe_pro_image_uri", helper_path
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for row in self.instances.values():
            with self.subTest(instance_id=row["instance_id"]):
                self.assertEqual(
                    harness.dockerhub_image_uri(row),
                    module.get_dockerhub_image_uri(
                        row["instance_id"],
                        harness.DOCKERHUB_USERNAME,
                        row["repo"],
                    ),
                )

    def test_plan_is_the_default_and_does_not_need_a_key(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = harness.main(["--checkout", str(self.checkout)])
        self.assertEqual(code, 0, stderr.getvalue())
        self.assertIn('"mode": "plan"', stdout.getvalue())
        self.assertIn("no image pull, container mutation, or inference", stdout.getvalue())

    def test_execute_without_environment_key_stops_before_docker(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = harness.main(
                    ["--checkout", str(self.checkout), "--execute"]
                )
        self.assertEqual(code, 2)
        self.assertIn("KRATER_API_KEY must be exported", stderr.getvalue())

    def test_evaluate_existing_runs_no_agent_or_key_path(self) -> None:
        row = self.instances[harness.SMOKE_INSTANCE]
        patch = "diff --git a/example b/example\n"
        with tempfile.TemporaryDirectory() as value:
            artifacts = Path(value)
            prediction = artifacts / "predictions.json"
            harness.write_json(
                prediction,
                harness.prediction_payload(harness.SMOKE_INSTANCE, patch),
            )
            (artifacts / "submission.diff").write_text(patch, encoding="utf-8")
            compatible = artifacts / harness.SMOKE_INSTANCE
            compatible.mkdir()
            harness.write_json(
                compatible / f"{harness.SMOKE_INSTANCE}.pred",
                {
                    "instance_id": harness.SMOKE_INSTANCE,
                    "model_name_or_path": harness.EXPECTED_MODEL,
                    "model_patch": patch,
                },
            )
            manifest = harness.plan_summary(
                checkout=self.checkout,
                row=row,
                image=harness.dockerhub_image_uri(row),
                limits=harness.validate_limits(
                    PureContractTests().limits()
                ),
                mode="execute",
                allow_pull=True,
                evaluate=False,
            )
            manifest.update(
                {
                    "status": "patch_generated",
                    "patch": {
                        "sha256": hashlib.sha256(patch.encode()).hexdigest(),
                        "bytes": len(patch.encode()),
                        "prediction_path": str(prediction.resolve()),
                    },
                }
            )
            harness.write_json(artifacts / "run.json", manifest)
            stdout = io.StringIO()
            stderr = io.StringIO()
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(harness, "evaluator_dependency_preflight"),
                mock.patch.object(harness.shutil, "which", return_value="/usr/bin/docker"),
                mock.patch.object(harness, "docker_preflight", return_value={"ok": True}),
                mock.patch.object(
                    harness, "run_official_evaluation", return_value=True
                ) as evaluator,
                mock.patch.object(
                    harness,
                    "ensure_image",
                    side_effect=AssertionError("agent image path must not run"),
                ),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                code = harness.main(
                    [
                        "--checkout",
                        str(self.checkout),
                        "--evaluate-existing",
                        str(artifacts),
                        "--pull",
                    ]
                )
                self.assertEqual(code, 0, stderr.getvalue())
                evaluator.assert_called_once()


class PureContractTests(unittest.TestCase):
    def limits(self, **changes: object) -> argparse.Namespace:
        values: dict[str, object] = {
            "agent_timeout_seconds": 3_600,
            "evaluation_timeout_seconds": 7_200,
            "max_steps": 96,
            "max_output_tokens": 8_192,
            "session_token_budget": 400_000,
            "context_chars": 180_000,
            "tool_output_chars": 24_000,
            "memory_gb": 6.0,
            "cpus": 2.0,
        }
        values.update(changes)
        return argparse.Namespace(**values)

    def test_exact_model_and_endpoint_are_immutable_constants(self) -> None:
        self.assertEqual(harness.EXPECTED_MODEL, "moonshotai/kimi-k3")
        self.assertEqual(harness.EXPECTED_BASE_URL, "https://api.krater.ai/v1")

    def test_parser_has_no_api_key_argument(self) -> None:
        options = {
            option
            for action in harness.parser()._actions
            for option in action.option_strings
        }
        self.assertNotIn("--api-key", options)
        self.assertNotIn("-k", options)

    def test_pull_requires_an_explicit_runtime_mode(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = harness.main(["--pull"])
        self.assertEqual(code, 2)
        self.assertIn("--pull is only valid", stderr.getvalue())

    def test_evaluation_requires_execution_and_pull(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = harness.main(["--evaluate"])
        self.assertEqual(code, 2)
        self.assertIn("--evaluate requires --execute", stderr.getvalue())

    def test_evaluate_existing_requires_explicit_pull(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = harness.main(["--evaluate-existing", "/tmp/example"])
        self.assertEqual(code, 2)
        self.assertIn("Official evaluation requires --pull", stderr.getvalue())

    def test_limits_are_bounded(self) -> None:
        limits = harness.validate_limits(self.limits())
        self.assertEqual(limits.max_steps, 96)
        with self.assertRaisesRegex(harness.HarnessError, "max-steps"):
            harness.validate_limits(self.limits(max_steps=129))
        with self.assertRaisesRegex(harness.HarnessError, "memory-gb"):
            harness.validate_limits(self.limits(memory_gb=1.0))

    def test_official_prediction_schema(self) -> None:
        self.assertEqual(
            harness.prediction_payload("instance_example", "diff --git ..."),
            [
                {
                    "instance_id": "instance_example",
                    "patch": "diff --git ...",
                    "prefix": "krater-pro-kimi-k3",
                }
            ],
        )

    def test_official_evaluator_is_single_worker_local_docker(self) -> None:
        checkout = Path("/tmp/official")
        command = harness.official_evaluator_command(
            checkout,
            Path("/tmp/raw.jsonl"),
            Path("/tmp/predictions.json"),
            Path("/tmp/eval"),
        )
        self.assertIn(str(checkout / "swe_bench_pro_eval.py"), command)
        self.assertEqual(
            command[command.index("--raw_sample_path") + 1],
            "/tmp/raw.jsonl",
        )
        self.assertEqual(command[command.index("--num_workers") + 1], "1")
        self.assertIn("--use_local_docker", command)
        self.assertIn("--block_network", command)
        self.assertEqual(
            command[command.index("--docker_platform") + 1],
            "linux/amd64",
        )

    def test_official_sample_normalizes_upstream_case_and_types(self) -> None:
        sample = harness.normalized_official_sample(
            {
                "instance_id": "instance_example",
                "base_commit": "a" * 40,
                "before_repo_set_cmd": "git checkout " + "a" * 40,
                "repo": "owner/repo",
                "selected_test_files_to_run": '["test/a.py"]',
                "FAIL_TO_PASS": ["test/a.py::test_fix"],
                "PASS_TO_PASS": '["test/a.py::test_existing"]',
                "patch": "gold must not be copied",
                "test_patch": "hidden tests must not be copied",
            }
        )
        self.assertEqual(
            json.loads(sample["fail_to_pass"]),
            ["test/a.py::test_fix"],
        )
        self.assertEqual(
            json.loads(sample["pass_to_pass"]),
            ["test/a.py::test_existing"],
        )
        self.assertNotIn("patch", sample)
        self.assertNotIn("test_patch", sample)

    def test_evaluator_dependency_preflight_fails_before_a_paid_run(self) -> None:
        missing = harness.ProcessResult(
            argv=(sys.executable,),
            returncode=1,
            stdout="",
            stderr="ModuleNotFoundError: docker",
            stdout_bytes=0,
            stderr_bytes=30,
            timed_out=False,
            duration_seconds=0.1,
        )
        with mock.patch.object(harness, "run_bounded", return_value=missing):
            with self.assertRaisesRegex(
                harness.HarnessError, "dependencies are unavailable"
            ):
                harness.evaluator_dependency_preflight()

    def test_problem_addendum_preserves_scope_and_secret_boundary(self) -> None:
        instruction = harness.build_instruction(
            {
                "problem_statement": "Fix the distribution bug.",
                "base_commit": "a" * 40,
            }
        )
        self.assertIn("Work only inside /app", instruction)
        self.assertIn("Do not read or print credentials", instruction)
        self.assertIn("Do not change, delete, or weaken existing tests", instruction)
        self.assertIn("<UNTRUSTED_ISSUE>", instruction)
        self.assertIn("Fix the distribution bug.", instruction)

    def test_vnan_image_mapping_matches_official_helper(self) -> None:
        row = {
            "instance_id": "instance_NodeBB__NodeBB-" + "a" * 40 + "-vnan",
            "repo": "NodeBB/NodeBB",
        }
        uri = harness.dockerhub_image_uri(row)
        self.assertEqual(
            uri,
            "jefzda/sweap-images:nodebb.nodebb-NodeBB__NodeBB-" + "a" * 40,
        )

    def test_invalid_repository_cannot_form_a_docker_reference(self) -> None:
        with self.assertRaisesRegex(harness.HarnessError, "invalid repo"):
            harness.dockerhub_image_uri(
                {"instance_id": "instance_safe", "repo": "owner/repo/extra"}
            )

    def test_redaction_removes_every_secret_occurrence(self) -> None:
        self.assertEqual(
            harness.redact("key=secret and secret", ["secret"]),
            "key=[redacted] and [redacted]",
        )

    def test_subprocess_capture_is_bounded(self) -> None:
        result = harness.run_bounded(
            [sys.executable, "-c", "print('x' * 10000)"],
            timeout=10,
            maximum_output=100,
        )
        self.assertEqual(result.returncode, 0)
        self.assertGreater(result.stdout_bytes, 100)
        self.assertIn("output truncated", result.stdout)

    def test_subprocesses_never_inherit_the_krater_key(self) -> None:
        with mock.patch.dict(
            os.environ, {"KRATER_API_KEY": "should-not-reach-child"}
        ):
            result = harness.run_bounded(
                [
                    sys.executable,
                    "-c",
                    (
                        "import os; "
                        "print(os.environ.get('KRATER_API_KEY', 'missing'))"
                    ),
                ],
                timeout=10,
            )
        self.assertEqual(result.stdout.strip(), "missing")

    def test_docker_resource_preflight_rejects_insufficient_memory(self) -> None:
        response = harness.ProcessResult(
            argv=("docker",),
            returncode=0,
            stdout=json.dumps(
                {
                    "memory": 3 * 1024**3,
                    "cpus": 8,
                    "architecture": "arm64",
                    "os": "linux",
                    "serverVersion": "test",
                }
            ),
            stderr="",
            stdout_bytes=100,
            stderr_bytes=0,
            timed_out=False,
            duration_seconds=0.1,
        )
        with mock.patch.object(harness, "checked", return_value=response):
            with self.assertRaisesRegex(harness.HarnessError, "below the configured"):
                harness.docker_preflight("docker", harness.validate_limits(self.limits()))

    def test_docker_resource_preflight_records_emulation(self) -> None:
        response = harness.ProcessResult(
            argv=("docker",),
            returncode=0,
            stdout=json.dumps(
                {
                    "memory": 8 * 1024**3,
                    "cpus": 8,
                    "architecture": "arm64",
                    "os": "linux",
                    "serverVersion": "test",
                }
            ),
            stderr="",
            stdout_bytes=100,
            stderr_bytes=0,
            timed_out=False,
            duration_seconds=0.1,
        )
        with mock.patch.object(harness, "checked", return_value=response):
            info = harness.docker_preflight(
                "docker", harness.validate_limits(self.limits())
            )
        self.assertTrue(info["emulationRequired"])
        self.assertEqual(info["platformRequested"], "linux/amd64")

    def test_agent_dockerfile_never_copies_a_secret(self) -> None:
        dockerfile = (
            harness.repository_root()
            / "benchmarks/swe_pro/Dockerfile.agent"
        ).read_text(encoding="utf-8")
        self.assertNotIn("KRATER_API_KEY", dockerfile)
        self.assertNotIn(".env", dockerfile)
        self.assertIn("COPY krater-pro.mjs", dockerfile)

    def test_build_context_accepts_bundle_already_in_context(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            artifacts = Path(value)
            build = artifacts / ".build"
            build.mkdir()
            bundle = build / "krater-pro.mjs"
            bundle.write_text("bundle", encoding="utf-8")
            context = harness.create_build_context(
                artifacts, bundle, harness.repository_root()
            )
            self.assertEqual(context, build)
            self.assertEqual(
                (context / "krater-pro.mjs").read_text(encoding="utf-8"),
                "bundle",
            )

    def test_agent_image_identity_hashes_full_context_and_resolved_images(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            context = Path(value)
            (context / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
            (context / "krater-pro.mjs").write_text("bundle\n", encoding="utf-8")
            skills = context / "skills/programming-languages"
            skills.mkdir(parents=True)
            skill = skills / "SKILL.md"
            skill.write_text("first\n", encoding="utf-8")
            first_digest = harness.build_context_sha256(context)
            first_identity = harness.agent_image_cache_identity(
                context_digest=first_digest,
                instance_image="example/image:tag",
                instance_image_id="sha256:" + "a" * 64,
                node_image_id="sha256:" + "b" * 64,
            )
            skill.write_text("second\n", encoding="utf-8")
            second_digest = harness.build_context_sha256(context)
            second_identity = harness.agent_image_cache_identity(
                context_digest=second_digest,
                instance_image="example/image:tag",
                instance_image_id="sha256:" + "a" * 64,
                node_image_id="sha256:" + "b" * 64,
            )
            (context / "Dockerfile").write_text(
                "FROM scratch\nLABEL changed=true\n",
                encoding="utf-8",
            )
            dockerfile_changed_digest = harness.build_context_sha256(context)
            node_changed = harness.agent_image_cache_identity(
                context_digest=second_digest,
                instance_image="example/image:tag",
                instance_image_id="sha256:" + "a" * 64,
                node_image_id="sha256:" + "c" * 64,
            )
        self.assertNotEqual(first_digest, second_digest)
        self.assertNotEqual(second_digest, dockerfile_changed_digest)
        self.assertNotEqual(first_identity, second_identity)
        self.assertNotEqual(second_identity, node_changed)

    def test_resolved_image_id_requires_an_immutable_digest(self) -> None:
        value = "sha256:" + "a" * 64
        self.assertEqual(harness.resolved_image_id({"id": value}, "image"), value)
        with self.assertRaisesRegex(harness.HarnessError, "immutable image ID"):
            harness.resolved_image_id({"id": "latest"}, "image")

    def test_checkout_integrity_rejects_relevant_dirty_files(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            checkout = Path(value).resolve()
            (checkout / "helper_code").mkdir()
            (checkout / "run_scripts/example").mkdir(parents=True)
            (checkout / "dockerfiles/instance_dockerfile/example").mkdir(
                parents=True
            )
            for relative in harness.CHECKOUT_RUNTIME_PATHS[:3]:
                path = checkout / relative
                path.write_text("pinned\n", encoding="utf-8")
            (checkout / "run_scripts/example/run_script.sh").write_text(
                "true\n", encoding="utf-8"
            )
            (checkout / "dockerfiles/instance_dockerfile/example/Dockerfile").write_text(
                "FROM scratch\n", encoding="utf-8"
            )
            subprocess.run(
                ["git", "init", "--quiet"],
                cwd=checkout,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            subprocess.run(
                ["git", "add", "."],
                cwd=checkout,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Krater Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "fixture",
                ],
                cwd=checkout,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            harness.ensure_checkout_runtime_clean(checkout)
            (checkout / "helper_code/image_uri.py").write_text(
                "tampered\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(harness.HarnessError, "tracked or untracked"):
                harness.ensure_checkout_runtime_clean(checkout)

    def test_instance_runtime_hash_catches_assume_unchanged_tampering(self) -> None:
        instance_id = "instance_owner__repo-" + "a" * 40 + "-v1"
        with tempfile.TemporaryDirectory() as value:
            checkout = Path(value).resolve()
            scripts = checkout / "run_scripts" / instance_id
            dockerfile = (
                checkout
                / "dockerfiles/instance_dockerfile"
                / instance_id
                / "Dockerfile"
            )
            scripts.mkdir(parents=True)
            dockerfile.parent.mkdir(parents=True)
            run_script = scripts / "run_script.sh"
            run_script.write_text("true\n", encoding="utf-8")
            (scripts / "parser.py").write_text("pass\n", encoding="utf-8")
            dockerfile.write_text("FROM scratch\n", encoding="utf-8")
            subprocess.run(
                ["git", "init", "--quiet"],
                cwd=checkout,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            subprocess.run(
                ["git", "add", "."],
                cwd=checkout,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Krater Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "fixture",
                ],
                cwd=checkout,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=checkout,
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ).stdout.strip()
            with mock.patch.object(harness, "EXPECTED_CHECKOUT_COMMIT", head):
                harness.validate_instance_runtime_files(checkout, instance_id)
                subprocess.run(
                    [
                        "git",
                        "update-index",
                        "--assume-unchanged",
                        str(run_script.relative_to(checkout)),
                    ],
                    cwd=checkout,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                run_script.write_text("tampered\n", encoding="utf-8")
                with self.assertRaisesRegex(
                    harness.HarnessError, "runtime file content changed"
                ):
                    harness.validate_instance_runtime_files(checkout, instance_id)

    def _existing_run_fixture(
        self,
        artifacts: Path,
    ) -> tuple[dict[str, dict[str, object]], dict[str, object]]:
        instance_id = "instance_owner__repo-" + "a" * 40 + "-v1"
        row: dict[str, object] = {
            "instance_id": instance_id,
            "repo": "owner/repo",
            "base_commit": "b" * 40,
        }
        patch = "diff --git a/file.txt b/file.txt\n"
        prediction = artifacts / "predictions.json"
        harness.write_json(
            prediction,
            harness.prediction_payload(instance_id, patch),
        )
        (artifacts / "submission.diff").write_text(patch, encoding="utf-8")
        compatible = artifacts / instance_id
        compatible.mkdir()
        harness.write_json(
            compatible / f"{instance_id}.pred",
            {
                "instance_id": instance_id,
                "model_name_or_path": harness.EXPECTED_MODEL,
                "model_patch": patch,
            },
        )
        manifest: dict[str, object] = {
            "adapter": "krater-pro/swe-bench-pro",
            "official_revision": harness.EXPECTED_CHECKOUT_COMMIT,
            "dataset_sha256": harness.EXPECTED_DATASET_SHA256,
            "evaluator_sha256": harness.EXPECTED_EVALUATOR_SHA256,
            "image_helper_sha256": harness.EXPECTED_IMAGE_HELPER_SHA256,
            "model": harness.EXPECTED_MODEL,
            "base_url": harness.EXPECTED_BASE_URL,
            "platform": harness.DEFAULT_PLATFORM,
            "instance_id": instance_id,
            "repo": row["repo"],
            "base_commit": row["base_commit"],
            "instance_image": harness.dockerhub_image_uri(row),
            "status": "patch_generated",
            "patch": {
                "sha256": hashlib.sha256(patch.encode()).hexdigest(),
                "bytes": len(patch.encode()),
                "prediction_path": str(prediction.resolve()),
            },
        }
        harness.write_json(artifacts / "run.json", manifest)
        return {instance_id: row}, manifest

    def test_existing_run_verifies_pins_instance_and_patch_sha(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            artifacts = Path(value)
            instances, manifest = self._existing_run_fixture(artifacts)
            existing = harness.validate_existing_run(artifacts, instances)
            self.assertEqual(existing.row["instance_id"], manifest["instance_id"])
            with self.assertRaisesRegex(harness.HarnessError, "--instance"):
                harness.validate_existing_run(
                    artifacts,
                    instances,
                    requested_instance="instance_other",
                )
            (artifacts / "submission.diff").write_text(
                "tampered\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(harness.HarnessError, "do not match"):
                harness.validate_existing_run(artifacts, instances)

    def test_existing_run_rejects_pin_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            artifacts = Path(value)
            instances, manifest = self._existing_run_fixture(artifacts)
            manifest["evaluator_sha256"] = "0" * 64
            harness.write_json(artifacts / "run.json", manifest)
            with self.assertRaisesRegex(harness.HarnessError, "evaluator_sha256"):
                harness.validate_existing_run(artifacts, instances)

    def test_timeout_cleanup_removes_only_owned_evaluator_container(self) -> None:
        owned = "a" * 64
        unrelated = "b" * 64
        before = {"c" * 64}
        workspace = Path("/tmp/krater-owned-workspace")
        owned_metadata = {
            "id": owned,
            "image": "official/image:tag",
            "path": "/bin/bash",
            "args": ["-c", "bash /workspace/entryscript.sh"],
            "mounts": [
                {
                    "Type": "bind",
                    "Source": str(workspace),
                    "Destination": "/workspace",
                }
            ],
        }
        unrelated_metadata = {
            **owned_metadata,
            "id": unrelated,
            "image": "someone-else/image:tag",
        }
        removed = harness.ProcessResult(
            argv=("docker",),
            returncode=0,
            stdout=owned,
            stderr="",
            stdout_bytes=len(owned),
            stderr_bytes=0,
            timed_out=False,
            duration_seconds=0.1,
        )
        with (
            mock.patch.object(
                harness,
                "list_container_ids",
                return_value=before | {owned, unrelated},
            ),
            mock.patch.object(
                harness,
                "inspect_evaluator_container",
                side_effect=lambda _docker, identifier: (
                    owned_metadata if identifier == owned else unrelated_metadata
                ),
            ),
            mock.patch.object(harness, "run_bounded", return_value=removed) as remove,
        ):
            cleanup = harness.cleanup_timed_out_evaluator_containers(
                "docker",
                before=before,
                instance_image="official/image:tag",
                workspace=workspace,
            )
        self.assertEqual(cleanup["removed"], [owned])
        self.assertEqual(cleanup["skipped"], [unrelated])
        remove.assert_called_once_with(
            ["docker", "container", "rm", "--force", owned],
            timeout=30,
            maximum_output=16_384,
        )

    def test_evaluator_timeout_records_truthful_attempt_and_cleanup(self) -> None:
        instance_id = "instance_owner__repo-" + "a" * 40 + "-v1"
        row = {
            "instance_id": instance_id,
            "base_commit": "b" * 40,
            "before_repo_set_cmd": "git reset --hard " + "b" * 40,
            "repo": "owner/repo",
            "selected_test_files_to_run": [],
            "FAIL_TO_PASS": [],
            "PASS_TO_PASS": [],
        }
        timeout = harness.ProcessResult(
            argv=("python",),
            returncode=-15,
            stdout="bounded output",
            stderr="",
            stdout_bytes=14,
            stderr_bytes=0,
            timed_out=True,
            duration_seconds=60.0,
        )
        cleanup = {
            "trigger": "official_evaluator_timeout",
            "new_container_count": 1,
            "removed": ["a" * 64],
            "skipped": [],
            "failed": [],
        }
        with tempfile.TemporaryDirectory() as value:
            artifacts = Path(value)
            prediction = artifacts / "predictions.json"
            prediction.write_text("[]\n", encoding="utf-8")
            manifest: dict[str, object] = {"status": "patch_generated"}
            harness.write_json(artifacts / "run.json", manifest)
            with (
                mock.patch.object(
                    harness, "list_container_ids", return_value={"b" * 64}
                ),
                mock.patch.object(harness, "run_bounded", return_value=timeout),
                mock.patch.object(
                    harness,
                    "cleanup_timed_out_evaluator_containers",
                    return_value=cleanup,
                ),
            ):
                with self.assertRaisesRegex(harness.HarnessError, "timed out"):
                    harness.run_official_evaluation(
                        checkout=Path("/tmp/official"),
                        docker="docker",
                        artifacts=artifacts,
                        manifest=manifest,
                        row=row,
                        prediction=prediction,
                        limits=harness.validate_limits(self.limits()),
                        source="evaluate-existing",
                    )
            persisted = json.loads(
                (artifacts / "run.json").read_text(encoding="utf-8")
            )
        self.assertEqual(persisted["status"], "evaluation_error")
        attempt = persisted["official_evaluation_attempts"][0]
        self.assertEqual(attempt["status"], "error")
        self.assertTrue(attempt["process"]["timed_out"])
        self.assertEqual(attempt["timeout_cleanup"], cleanup)

    def test_official_failure_is_a_benchmark_result_not_harness_error(self) -> None:
        instance_id = "instance_owner__repo-" + "a" * 40 + "-v1"
        row = {
            "instance_id": instance_id,
            "base_commit": "b" * 40,
            "before_repo_set_cmd": "git reset --hard " + "b" * 40,
            "repo": "owner/repo",
            "selected_test_files_to_run": [],
            "FAIL_TO_PASS": [],
            "PASS_TO_PASS": [],
        }

        def evaluator_result(argv: list[str], **_kwargs: object) -> harness.ProcessResult:
            output = Path(argv[argv.index("--output_dir") + 1])
            harness.write_json(output / "eval_results.json", {instance_id: False})
            return harness.ProcessResult(
                argv=tuple(argv),
                returncode=0,
                stdout="Overall accuracy: 0",
                stderr="",
                stdout_bytes=19,
                stderr_bytes=0,
                timed_out=False,
                duration_seconds=1.0,
            )

        with tempfile.TemporaryDirectory() as value:
            artifacts = Path(value)
            prediction = artifacts / "predictions.json"
            prediction.write_text("[]\n", encoding="utf-8")
            manifest: dict[str, object] = {"status": "patch_generated"}
            harness.write_json(artifacts / "run.json", manifest)
            with (
                mock.patch.object(harness, "list_container_ids", return_value=set()),
                mock.patch.object(
                    harness, "run_bounded", side_effect=evaluator_result
                ),
            ):
                passed = harness.run_official_evaluation(
                    checkout=Path("/tmp/official"),
                    docker="docker",
                    artifacts=artifacts,
                    manifest=manifest,
                    row=row,
                    prediction=prediction,
                    limits=harness.validate_limits(self.limits()),
                    source="evaluate-existing",
                )
            persisted = json.loads(
                (artifacts / "run.json").read_text(encoding="utf-8")
            )
        self.assertFalse(passed)
        self.assertEqual(persisted["status"], "failed")
        self.assertFalse(persisted["official_result"]["passed"])
        self.assertEqual(
            persisted["official_evaluation_attempts"][0]["status"],
            "failed",
        )

    def test_agent_source_pins_model_and_removes_secret_before_agent(self) -> None:
        source = (
            harness.repository_root() / "benchmarks/swe_pro/agent_entry.ts"
        ).read_text(encoding="utf-8")
        self.assertIn('const EXPECTED_MODEL = "moonshotai/kimi-k3"', source)
        self.assertIn('const EXPECTED_BASE_URL = "https://api.krater.ai/v1"', source)
        self.assertIn("readAndRemoveSecret(options.secretFile)", source)
        self.assertNotIn("process.env.KRATER_API_KEY", source)


if __name__ == "__main__":
    unittest.main()

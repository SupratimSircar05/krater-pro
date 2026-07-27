from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from run_deep_swe import (
    ADAPTER_IMPORT,
    EXPECTED_MODEL,
    build_pier_command,
    parser,
    validate_official_checkout,
    validate_task_names,
)


class DeepSweRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.tasks = self.root / "tasks"
        (self.tasks / "example").mkdir(parents=True)
        (self.tasks / "example/task.toml").write_text("", encoding="utf-8")
        self.pier = self.root / "pier"
        self.pier.write_text("", encoding="utf-8")
        self.bundle = self.root / "krater-pro.mjs"
        self.bundle.write_text("", encoding="utf-8")
        self.skills = self.root / "skills"
        self.skills.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_requires_explicit_task_scope(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least one"):
            validate_task_names(self.tasks, [], False)

    def test_rejects_unknown_or_traversing_task(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid"):
            validate_task_names(self.tasks, ["../example"], False)
        with self.assertRaisesRegex(ValueError, "Unknown"):
            validate_task_names(self.tasks, ["missing"], False)

    def test_live_command_keeps_secret_out_of_agent_environment(self) -> None:
        command = build_pier_command(
            pier=self.pier,
            tasks_root=self.tasks,
            bundle=self.bundle,
            skills_dir=self.skills,
            task_names=["example"],
            run_all=False,
            jobs_dir=self.root / "jobs",
            env_file=self.root / ".env",
            infrastructure_only=False,
            n_concurrent=1,
        )
        joined = "\n".join(command)
        self.assertIn(ADAPTER_IMPORT, command)
        self.assertIn(EXPECTED_MODEL, command)
        self.assertIn("--env-file", command)
        self.assertNotIn("--agent-env", command)
        self.assertNotIn("KRATER_API_KEY", joined)
        self.assertNotIn("kr_live_", joined)
        self.assertIn("--include-task-name", command)
        self.assertNotIn("--disable-verification", command)

    def test_infrastructure_command_cannot_invoke_model(self) -> None:
        command = build_pier_command(
            pier=self.pier,
            tasks_root=self.tasks,
            bundle=self.bundle,
            skills_dir=self.skills,
            task_names=["example"],
            run_all=False,
            jobs_dir=self.root / "jobs",
            env_file=None,
            infrastructure_only=True,
            n_concurrent=1,
        )
        self.assertIn("dry_run=true", command)
        self.assertIn("--disable-verification", command)
        self.assertNotIn("--agent-env", command)

    def test_official_checkout_must_be_pinned_and_clean(self) -> None:
        checkout = self.root / "checkout"
        tasks = checkout / "tasks"
        tasks.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        subprocess.run(
            ["git", "-C", str(checkout), "config", "user.name", "Test"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(checkout), "config", "user.email", "test@example.test"],
            check=True,
        )
        (tasks / "dataset.toml").write_text("", encoding="utf-8")
        (tasks / "manifest.json").write_text("{}", encoding="utf-8")
        subprocess.run(["git", "-C", str(checkout), "add", "tasks"], check=True)
        subprocess.run(
            ["git", "-C", str(checkout), "commit", "-qm", "fixture"],
            check=True,
        )
        revision = subprocess.run(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        validate_official_checkout(tasks.resolve(), expected_commit=revision)

        (tasks / "manifest.json").write_text('{"dirty":true}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "must be clean"):
            validate_official_checkout(tasks.resolve(), expected_commit=revision)

    def test_default_results_directory_is_adapter_local_and_ignored(self) -> None:
        args = parser().parse_args(
            ["--tasks-root", str(self.tasks), "--task", "example"]
        )
        self.assertTrue(args.jobs_dir.endswith("benchmarks/deep_swe/results"))
        ignore = Path(__file__).with_name(".gitignore").read_text()
        self.assertIn("/results/", ignore.splitlines())


if __name__ == "__main__":
    unittest.main()

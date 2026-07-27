from __future__ import annotations

import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

from benchmarks.swe_atlas.prepare_task import (
    clean_prepared_tasks,
    enforce_agent_allowlist,
    official_agent_hosts,
    prepare_task,
    validate_upstream_checkout,
    validate_task_tree,
)


def task_toml(agent_policy: str = "") -> str:
    return f"""schema_version = "1.1"

[task]
name = "scale-ai/task-example"

[agent]
timeout_sec = 10800
{agent_policy}
[environment]
allow_internet = true
"""


class PrepareTaskTests(unittest.TestCase):
    def test_public_task_becomes_krater_only(self) -> None:
        rewritten, hosts = enforce_agent_allowlist(task_toml())
        parsed = tomllib.loads(rewritten)
        self.assertEqual(hosts, ["api.krater.ai"])
        self.assertEqual(parsed["agent"]["network_mode"], "allowlist")
        self.assertEqual(parsed["agent"]["allowed_hosts"], ["api.krater.ai"])
        self.assertEqual(parsed["agent"]["timeout_sec"], 10800)

    def test_official_allowlist_is_preserved_and_krater_is_added_once(self) -> None:
        original = task_toml(
            """network_mode = "allowlist"
allowed_hosts = [
  "pypi.org",
  "registry.npmjs.org",
  "api.krater.ai",
]
"""
        )
        self.assertEqual(
            official_agent_hosts(original),
            ["pypi.org", "registry.npmjs.org", "api.krater.ai"],
        )
        rewritten, hosts = enforce_agent_allowlist(original)
        self.assertEqual(
            hosts,
            ["pypi.org", "registry.npmjs.org", "api.krater.ai"],
        )
        self.assertEqual(rewritten.count('network_mode = "allowlist"'), 1)
        self.assertEqual(rewritten.count('"api.krater.ai"'), 1)

    def test_missing_agent_section_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, r"\[agent\]"):
            enforce_agent_allowlist("[task]\nname = \"x\"\n")

    def test_prepare_copies_task_and_refuses_implicit_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_root = root / "upstream"
            source = source_root / "data" / "qa" / "task-example"
            (source / "environment").mkdir(parents=True)
            (source / "task.toml").write_text(task_toml())
            (source / "instruction.md").write_text("Inspect the code.")
            (source / "environment" / "Dockerfile").write_text("FROM scratch\n")
            output = root / "prepared"

            destination, hosts = prepare_task(
                source_root,
                output,
                "qa",
                "task-example",
                verify_commit=False,
            )
            self.assertEqual(hosts, ["api.krater.ai"])
            self.assertTrue((destination / "instruction.md").is_file())
            self.assertEqual(
                tomllib.loads((destination / "task.toml").read_text())["agent"][
                    "allowed_hosts"
                ],
                ["api.krater.ai"],
            )

            with self.assertRaises(FileExistsError):
                prepare_task(
                    source_root,
                    output,
                    "qa",
                    "task-example",
                    verify_commit=False,
                )

            replaced, _ = prepare_task(
                source_root,
                output,
                "qa",
                "task-example",
                overwrite=True,
                verify_commit=False,
            )
            self.assertEqual(replaced, destination)

    def test_clean_output_removes_only_direct_task_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "task-one").mkdir()
            (root / "task-two").mkdir()
            (root / "keep-me").mkdir()
            (root / "task-note.txt").write_text("keep")
            self.assertEqual(clean_prepared_tasks(root), 2)
            self.assertFalse((root / "task-one").exists())
            self.assertFalse((root / "task-two").exists())
            self.assertTrue((root / "keep-me").is_dir())
            self.assertTrue((root / "task-note.txt").is_file())

    def test_task_tree_rejects_escaping_and_broken_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = root / "task-example"
            task.mkdir()
            outside = root / "outside.txt"
            outside.write_text("private")
            (task / "escape").symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "escapes"):
                validate_task_tree(task)
            (task / "escape").unlink()
            (task / "broken").symlink_to(root / "missing")
            with self.assertRaisesRegex(ValueError, "broken"):
                validate_task_tree(task)

    def test_upstream_checkout_must_be_pinned_and_clean(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(
                ["git", "-C", str(root), "config", "user.name", "Test"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(root), "config", "user.email", "test@example.test"],
                check=True,
            )
            (root / "fixture.txt").write_text("clean\n")
            subprocess.run(["git", "-C", str(root), "add", "fixture.txt"], check=True)
            subprocess.run(
                ["git", "-C", str(root), "commit", "-qm", "fixture"],
                check=True,
            )
            revision = subprocess.run(
                ["git", "-C", str(root), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertEqual(
                validate_upstream_checkout(root, expected_commit=revision),
                revision,
            )
            (root / "untracked.txt").write_text("dirty\n")
            with self.assertRaisesRegex(ValueError, "must be clean"):
                validate_upstream_checkout(root, expected_commit=revision)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from benchmarks.swe_atlas.agent_core import EXACT_MODEL
from benchmarks.swe_atlas.krater_agent import KraterProAtlasAgent


class FakeHarborEnvironment:
    def __init__(self) -> None:
        self.default_user = "agent"
        self.commands: list[tuple[str, dict[str, str] | None, str | int | None]] = []
        self.uploads: dict[str, bytes] = {}
        self.uploaded_directories: list[tuple[Path, str]] = []

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        del cwd, timeout_sec
        self.commands.append((command, env, user))
        if "--version" in command:
            return ExecResult(stdout="0.1.0\n", return_code=0)
        if "payload-verify.mjs" in command:
            return ExecResult(stdout="payload verified\n", return_code=0)
        if "SWE-Atlas repository was dirty" in command:
            return ExecResult(stdout=f"/app\n{'a' * 40}\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads[target_path] = Path(source_path).read_bytes()

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        self.uploaded_directories.append((Path(source_dir), target_dir))


class HarborAdapterTests(unittest.IsolatedAsyncioTestCase):
    def fixture(
        self,
        root: Path,
        *,
        task_kind: str = "qa",
        **kwargs: object,
    ) -> KraterProAtlasAgent:
        root.mkdir(parents=True, exist_ok=True)
        bundle = root / "krater-pro.mjs"
        bundle.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        skills = root / "skills"
        language = skills / "programming-languages"
        language.mkdir(parents=True)
        (language / "SKILL.md").write_text(
            "---\nname: programming-languages\ndescription: Test.\n---\n",
            encoding="utf-8",
        )
        return KraterProAtlasAgent(
            logs_dir=root / "logs",
            model_name=EXACT_MODEL,
            task_kind=task_kind,
            bundle_path=str(bundle),
            skills_path=str(skills),
            **kwargs,
        )

    async def test_actual_harbor_api_uses_host_only_ephemeral_secret(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            secret = "kr_test_harbor_host_only"
            agent = self.fixture(root)
            environment = FakeHarborEnvironment()
            context = AgentContext()

            with patch.dict(os.environ, {"KRATER_API_KEY": secret}):
                await agent.setup(environment)  # type: ignore[arg-type]
                await agent.run(
                    "Inspect the repository and answer.",
                    environment,  # type: ignore[arg-type]
                    context,
                )

            joined = "\n".join(command for command, _env, _user in environment.commands)
            self.assertNotIn(secret, joined)
            self.assertNotIn("KRATER_API_KEY", joined)
            self.assertIn("--secret-file /run/krater-pro-api-key", joined)
            self.assertIn("payload-verify.mjs", joined)
            self.assertIn(f"base={'a' * 40}", joined)
            self.assertEqual(
                environment.uploads["/run/krater-pro-api-key"].decode(),
                secret,
            )
            self.assertIn("/installed-agent/payload-manifest.json", environment.uploads)
            self.assertIn("/installed-agent/payload-verify.mjs", environment.uploads)
            self.assertTrue(environment.uploaded_directories)
            self.assertTrue(
                all(not env or "KRATER_API_KEY" not in env for _, env, _ in environment.commands)
            )
            self.assertTrue((root / "logs/setup/bundle.sha256").is_file())
            self.assertTrue((root / "logs/setup/skills.sha256").is_file())

    async def test_rejects_secret_in_harbor_agent_config_env(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            agent = self.fixture(
                Path(temporary),
                extra_env={"KRATER_API_KEY": "must-stay-host-side"},
            )
            with self.assertRaisesRegex(RuntimeError, "host environment"):
                await agent.run(
                    "test",
                    FakeHarborEnvironment(),  # type: ignore[arg-type]
                    AgentContext(),
                )

    async def test_all_submission_capture_shells_parse_as_bash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for kind in ("qa", "tw", "rf"):
                agent = self.fixture(root / kind, task_kind=kind)
                shell = agent._submission_capture_shell("/app", "a" * 40)
                parsed = subprocess.run(
                    ["bash", "-n", "-c", shell],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(parsed.returncode, 0, parsed.stderr)

    async def test_revision_capture_includes_commits_and_qa_rejects_edits(self) -> None:
        loop = asyncio.get_running_loop()
        loop.set_debug(False)
        loop.slow_callback_duration = 10.0
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            logs = root / "agent-logs"
            workspace.mkdir()
            logs.mkdir()
            subprocess.run(["git", "init", "-q", str(workspace)], check=True)
            subprocess.run(
                ["git", "-C", str(workspace), "config", "user.name", "Test"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(workspace),
                    "config",
                    "user.email",
                    "test@example.test",
                ],
                check=True,
            )
            tracked = workspace / "tracked.txt"
            tracked.write_text("before\n")
            subprocess.run(["git", "-C", str(workspace), "add", "tracked.txt"], check=True)
            subprocess.run(
                ["git", "-C", str(workspace), "commit", "-qm", "base"],
                check=True,
            )
            base = subprocess.run(
                ["git", "-C", str(workspace), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

            tracked.write_text("after\n")
            subprocess.run(["git", "-C", str(workspace), "add", "tracked.txt"], check=True)
            subprocess.run(
                ["git", "-C", str(workspace), "commit", "-qm", "agent commit"],
                check=True,
            )
            (workspace / "untracked.txt").write_text("new\n")
            (logs / "manifest.txt").write_text(
                "<<TEST_MANIFEST>>\n- test\n<<TEST_MANIFEST>>\n"
            )
            tw_agent = self.fixture(root / "tw-adapter", task_kind="tw")
            tw_shell = tw_agent._submission_capture_shell(str(workspace), base)
            tw_shell = tw_shell.replace("/logs/agent", str(logs))
            captured = subprocess.run(
                ["bash", "-c", f"set -euo pipefail\n{tw_shell}"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(captured.returncode, 0, captured.stderr)
            patch_text = (logs / "submission.diff").read_text()
            self.assertIn("+after", patch_text)
            self.assertIn("untracked.txt", patch_text)

            qa_workspace = root / "qa-workspace"
            qa_workspace.mkdir()
            subprocess.run(["git", "init", "-q", str(qa_workspace)], check=True)
            subprocess.run(
                ["git", "-C", str(qa_workspace), "config", "user.name", "Test"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(qa_workspace),
                    "config",
                    "user.email",
                    "test@example.test",
                ],
                check=True,
            )
            qa_tracked = qa_workspace / "tracked.txt"
            qa_tracked.write_text("before\n")
            subprocess.run(
                ["git", "-C", str(qa_workspace), "add", "tracked.txt"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(qa_workspace), "commit", "-qm", "base"],
                check=True,
            )
            qa_base = subprocess.run(
                ["git", "-C", str(qa_workspace), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            (logs / "answer.txt").write_text(
                "<<FINAL_ANSWER>>\nanswer\n<<FINAL_ANSWER>>\n"
            )
            qa_agent = self.fixture(root / "qa-adapter", task_kind="qa")
            qa_shell = qa_agent._submission_capture_shell(
                str(qa_workspace),
                qa_base,
            )
            qa_shell = qa_shell.replace("/logs/agent", str(logs))
            clean = subprocess.run(
                ["bash", "-c", f"set -euo pipefail\n{qa_shell}"],
                check=False,
            )
            self.assertEqual(clean.returncode, 0)
            qa_tracked.write_text("forbidden\n")
            dirty = subprocess.run(
                ["bash", "-c", f"set -euo pipefail\n{qa_shell}"],
                check=False,
            )
            self.assertNotEqual(dirty.returncode, 0)


if __name__ == "__main__":
    unittest.main()

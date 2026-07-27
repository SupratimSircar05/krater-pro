from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pier.models.agent.context import AgentContext
from pier.environments.base import ExecResult

from krater_pier_agent import (
    BRANCH_NAME,
    DEFAULT_BASE_URL,
    EXPECTED_MODEL,
    REMOTE_SECRET,
    KraterProAgent,
    RuntimeLimits,
    build_agent_command,
    parse_usage_log,
)


class KraterPierAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.bundle = root / "krater-pro.mjs"
        self.bundle.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        self.skills = root / "skills"
        skill = self.skills / "programming-languages"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: programming-languages\ndescription: Test.\n---\n",
            encoding="utf-8",
        )
        self.logs = root / "logs"
        self.logs.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def agent(self, **kwargs: object) -> KraterProAgent:
        return KraterProAgent(
            logs_dir=self.logs,
            model_name=EXPECTED_MODEL,
            bundle_path=str(self.bundle),
            product_skills_dir=str(self.skills),
            **kwargs,
        )

    def test_requires_exact_kimi_k3_model(self) -> None:
        with self.assertRaisesRegex(ValueError, "exact model"):
            KraterProAgent(
                logs_dir=self.logs,
                model_name="openai/gpt-4o-mini",
                bundle_path=str(self.bundle),
                product_skills_dir=str(self.skills),
            )

    def test_command_is_bounded_and_never_contains_key(self) -> None:
        secret = "kr_test_should_never_appear"
        command = build_agent_command(
            "Fix the repository; echo 'quoted safely'.",
            base_url=DEFAULT_BASE_URL,
            limits=RuntimeLimits(
                run_timeout_sec=300,
                max_steps=20,
                max_output_tokens=4096,
                session_token_budget=50_000,
                context_chars=120_000,
                tool_output_chars=18_000,
                log_bytes=65_536,
            ),
        )
        self.assertNotIn(secret, command)
        self.assertIn(f"--secret-file {REMOTE_SECRET}", command)
        self.assertNotIn("KRATER_API_KEY=", command)
        self.assertIn("--cwd /app", command)
        self.assertIn("timeout --signal=TERM --kill-after=15s 300s", command)
        self.assertIn("tail -c 65536", command)

    def test_allowlist_is_only_configured_api_host(self) -> None:
        agent = self.agent()
        self.assertEqual(agent.network_allowlist().domains, ["api.krater.ai"])

    def test_rejects_insecure_remote_base_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            self.agent(
                extra_env={
                    "KRATER_API_KEY": "secret",
                    "KRATER_BASE_URL": "http://api.krater.ai/v1",
                }
            )

    def test_install_spec_has_no_network_install(self) -> None:
        spec = self.agent().install_spec()
        commands = "\n".join(step.run for step in spec.steps)
        self.assertNotIn("npm install", commands)
        self.assertNotIn("curl", commands)
        self.assertIn("node", commands)
        self.assertIn("a===20&&b>=19", commands)
        self.assertIn("a===22&&b>=12", commands)
        self.assertIn("a>22", commands)
        self.assertEqual(spec.agent_name, "krater-pro")

    def test_parses_last_cumulative_usage_line(self) -> None:
        usage = parse_usage_log(
            "\x1b[2mtokens: 120 · cached request 20\x1b[0m\n"
            "\x1b[2mtokens: 90 · session 210 · cached request 30 "
            "· cached session 50\x1b[0m\n"
        )
        self.assertEqual(
            usage,
            {
                "request_total_tokens": 90,
                "session_total_tokens": 210,
                "request_cached_tokens": 30,
                "session_cached_tokens": 50,
            },
        )

    def test_parses_structured_usage_from_benchmark_entrypoint(self) -> None:
        usage = parse_usage_log(
            '{"type":"usage","promptTokens":80,"completionTokens":15,'
            '"totalTokens":95,"cachedTokens":20,"sessionPromptTokens":240,'
            '"sessionCompletionTokens":40,"sessionTotalTokens":280,'
            '"sessionCachedTokens":75,"requestCount":3}\n'
        )
        self.assertEqual(usage["session_prompt_tokens"], 240)
        self.assertEqual(usage["session_completion_tokens"], 40)
        self.assertEqual(usage["session_total_tokens"], 280)
        self.assertEqual(usage["session_cached_tokens"], 75)

    def test_populates_context_without_inventing_input_output_split(self) -> None:
        (self.logs / "krater-pro.txt").write_text(
            '{"type":"tool","id":"1","name":"read_file"}\n'
            '{"type":"tool","id":"2","name":"run_command"}\n'
            '{"type":"usage","promptTokens":75,"completionTokens":20,'
            '"totalTokens":95,"sessionPromptTokens":250,'
            '"sessionCompletionTokens":60,"sessionTotalTokens":310,'
            '"sessionCachedTokens":80}\n'
            '{"type":"done","steps":4}\n',
            encoding="utf-8",
        )
        context = AgentContext()
        self.agent().populate_context_post_run(context)
        self.assertEqual(context.n_input_tokens, 250)
        self.assertEqual(context.n_output_tokens, 60)
        self.assertEqual(context.n_cache_tokens, 80)
        self.assertEqual(context.n_agent_steps, 4)
        self.assertEqual(
            context.metadata["krater_pro"]["session_total_tokens"], 310
        )

    def test_secret_is_not_in_install_spec_or_agent_metadata(self) -> None:
        secret = "kr_live_no_logs_123"
        with patch.dict(os.environ, {"KRATER_API_KEY": secret}):
            agent = self.agent()
            self.assertNotIn(secret, agent.install_spec().model_dump_json())
            self.assertNotIn(secret, agent.to_agent_info().model_dump_json())

    def test_rejects_secret_in_pier_agent_environment(self) -> None:
        agent = self.agent(extra_env={"KRATER_API_KEY": "must-stay-host-side"})
        with self.assertRaisesRegex(ValueError, "host environment"):
            import asyncio

            asyncio.run(agent.run("test", FakeEnvironment(), AgentContext()))

    def test_limits_reject_unbounded_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "max_steps"):
            self.agent(max_steps=129)


class FakeEnvironment:
    def __init__(self) -> None:
        self.default_user = None
        self.agent_install_spec = None
        self.commands: list[str] = []
        self.command_envs: list[dict[str, str] | None] = []
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
        self.commands.append(command)
        self.command_envs.append(env)
        if "git rev-parse HEAD" in command:
            return ExecResult(stdout="a" * 40, return_code=0)
        if "--version" in command:
            return ExecResult(stdout="0.1.0\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads[target_path] = Path(source_path).read_bytes()

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        self.uploaded_directories.append((Path(source_dir), target_dir))


class LocalGitEnvironment:
    def __init__(self, repository: Path) -> None:
        self.repository = repository
        self.default_user = None
        self.agent_install_spec = None

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        del cwd, user
        completed = subprocess.run(
            ["bash", "-c", command],
            cwd=self.repository,
            env={**os.environ, **(env or {})},
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        return ExecResult(
            stdout=completed.stdout,
            stderr=completed.stderr,
            return_code=completed.returncode,
        )


class KraterPierAgentAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_handoff_never_puts_secret_in_executed_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bundle = root / "krater-pro.mjs"
            bundle.write_text("#!/usr/bin/env node\n", encoding="utf-8")
            skills = root / "skills"
            (skills / "programming-languages").mkdir(parents=True)
            (skills / "programming-languages/SKILL.md").write_text(
                "---\nname: programming-languages\ndescription: Test.\n---\n",
                encoding="utf-8",
            )
            logs = root / "logs"
            logs.mkdir()
            secret = "kr_test_adapter_handoff"
            with patch.dict(os.environ, {"KRATER_API_KEY": secret}):
                agent = KraterProAgent(
                    logs_dir=logs,
                    model_name=EXPECTED_MODEL,
                    bundle_path=str(bundle),
                    product_skills_dir=str(skills),
                )
                environment = FakeEnvironment()
                environment.agent_install_spec = agent.install_spec()

                await agent.setup(environment)  # type: ignore[arg-type]
                context = AgentContext()
                await agent.run(
                    "Make a small, verified change.",
                    environment,  # type: ignore[arg-type]
                    context,
                )

            self.assertIn(REMOTE_SECRET, environment.uploads)
            self.assertEqual(
                environment.uploads[REMOTE_SECRET].decode("utf-8"), secret
            )
            self.assertTrue(environment.uploaded_directories)
            self.assertTrue(any("--secret-file" in value for value in environment.commands))
            self.assertTrue(
                any("commit --no-gpg-sign" in value for value in environment.commands)
            )
            self.assertTrue(any("git switch -C krater-pro-eval" in value for value in environment.commands))
            self.assertTrue(any("task repository was dirty" in value for value in environment.commands))
            self.assertNotIn(secret, "\n".join(environment.commands))
            self.assertTrue(
                all(not env or "KRATER_API_KEY" not in env for env in environment.command_envs)
            )
            self.assertEqual(
                context.metadata["krater_pro"]["model"], EXPECTED_MODEL
            )

    async def test_existing_eval_branch_resets_to_captured_base(self) -> None:
        loop = asyncio.get_running_loop()
        loop.set_debug(False)
        loop.slow_callback_duration = 10.0
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repository = root / "repository"
            repository.mkdir()
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
            subprocess.run(
                ["git", "-C", str(repository), "config", "user.name", "Test"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository),
                    "config",
                    "user.email",
                    "test@example.test",
                ],
                check=True,
            )
            tracked = repository / "tracked.txt"
            tracked.write_text("base\n")
            subprocess.run(
                ["git", "-C", str(repository), "add", "tracked.txt"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(repository), "commit", "-qm", "base"],
                check=True,
            )
            base = subprocess.run(
                ["git", "-C", str(repository), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            subprocess.run(
                ["git", "-C", str(repository), "switch", "-qc", BRANCH_NAME],
                check=True,
            )
            stale = repository / "stale.txt"
            stale.write_text("stale\n")
            subprocess.run(
                ["git", "-C", str(repository), "add", "stale.txt"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(repository), "commit", "-qm", "stale"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(repository), "switch", "-q", "-"],
                check=True,
            )

            bundle = root / "krater-pro.mjs"
            bundle.write_text("#!/usr/bin/env node\n")
            skills = root / "skills/programming-languages"
            skills.mkdir(parents=True)
            (skills / "SKILL.md").write_text("---\nname: programming-languages\n---\n")
            logs = root / "logs"
            logs.mkdir()
            agent = KraterProAgent(
                logs_dir=logs,
                model_name=EXPECTED_MODEL,
                bundle_path=str(bundle),
                product_skills_dir=str(root / "skills"),
            )
            agent._task_base_commit = base
            environment = LocalGitEnvironment(repository)
            prepared_base = await agent._prepare_git(environment)  # type: ignore[arg-type]
            self.assertEqual(prepared_base, base)
            self.assertFalse(stale.exists())

            tracked.write_text("solution\n")
            await agent._finalize_git(  # type: ignore[arg-type]
                environment,
                base,
            )
            final = subprocess.run(
                ["git", "-C", str(repository), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertNotEqual(final, base)
            self.assertEqual(
                subprocess.run(
                    ["git", "-C", str(repository), "status", "--porcelain"],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout,
                "",
            )


if __name__ == "__main__":
    unittest.main()

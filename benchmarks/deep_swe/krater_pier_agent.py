"""Pier 0.3 adapter that runs the Krater Pro CLI against DeepSWE tasks.

The adapter intentionally installs a host-built, self-contained JavaScript bundle.
DeepSWE blocks general runtime internet access, so installing npm dependencies from
inside the task container would both weaken isolation and make runs irreproducible.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from pier.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
)
from pier.environments.base import BaseEnvironment, ExecResult
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

EXPECTED_MODEL = "moonshotai/kimi-k3"
DEFAULT_BASE_URL = "https://api.krater.ai/v1"
REMOTE_ROOT = "/opt/krater-pro"
REMOTE_BUNDLE = f"{REMOTE_ROOT}/dist/cli.mjs"
REMOTE_SKILLS = f"{REMOTE_ROOT}/skills"
REMOTE_BINARY = "/usr/local/bin/krater"
REMOTE_LOG = "/logs/agent/krater-pro.txt"
REMOTE_SECRET = "/run/krater-pro-api-key"
BRANCH_NAME = "krater-pro-eval"
_GIT_OID = re.compile(r"^[0-9a-f]{40,64}$")

_ANSI_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_ANSI_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_USAGE_LINE = re.compile(
    r"tokens:\s*(?P<request>\d+)"
    r"(?:\s*[·|]\s*session\s+(?P<session>\d+))?"
    r"(?:\s*[·|]\s*cached request\s+(?P<request_cached>\d+))?"
    r"(?:\s*[·|]\s*cached session\s+(?P<session_cached>\d+))?"
)


def _bounded_int(
    value: object,
    *,
    name: str,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{name} must be an integer from {minimum} to {maximum}"
        ) from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")
    return parsed


def _validate_base_url(value: str) -> str:
    cleaned = value.strip().rstrip("/")
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("KRATER_BASE_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise ValueError("KRATER_BASE_URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("KRATER_BASE_URL must not contain a query or fragment")
    loopback = parsed.hostname.lower() in {"127.0.0.1", "localhost", "::1"}
    if parsed.scheme != "https" and not loopback:
        raise ValueError("KRATER_BASE_URL must use HTTPS except on loopback")
    return cleaned


def _validate_local_file(
    value: str | Path,
    *,
    label: str,
    maximum_bytes: int,
) -> Path:
    path = Path(value).expanduser().resolve()
    try:
        details = path.stat()
    except OSError as exc:
        raise ValueError(f"{label} does not exist: {path}") from exc
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"{label} is not a regular file: {path}")
    if details.st_size < 1 or details.st_size > maximum_bytes:
        raise ValueError(
            f"{label} must contain 1 to {maximum_bytes} bytes: {path}"
        )
    return path


def _validate_local_directory(value: str | Path, *, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"{label} is not a directory: {path}")
    return path


def _strip_terminal_controls(value: str) -> str:
    return _CONTROL.sub("", _ANSI_CSI.sub("", _ANSI_OSC.sub("", value)))


@dataclass(frozen=True)
class RuntimeLimits:
    run_timeout_sec: int
    max_steps: int
    max_output_tokens: int
    session_token_budget: int
    context_chars: int
    tool_output_chars: int
    log_bytes: int


def build_agent_command(
    instruction: str,
    *,
    base_url: str,
    limits: RuntimeLimits,
    secret_path: str = REMOTE_SECRET,
) -> str:
    """Build the bounded runtime command without embedding credential material."""
    harness_note = (
        "\n\n[Krater Pro DeepSWE harness]\n"
        "Work only in /app. The harness already created a dedicated branch from "
        "the task's starting HEAD. Do not create another branch. Inspect the "
        "repository before editing, run the most relevant tests, and commit all "
        "completed changes. Never read, print, or expose credentials or .env files."
    )
    prompt = shlex.quote(instruction + harness_note)
    base = shlex.quote(base_url)
    secret = shlex.quote(secret_path)
    log = shlex.quote(REMOTE_LOG)
    binary = shlex.quote(REMOTE_BINARY)

    # The entrypoint reads and unlinks the secret before it constructs AgentSession.
    # Tool subprocesses therefore cannot inherit it or read it from the filesystem.
    return (
        "set -o pipefail; "
        f"timeout --signal=TERM --kill-after=15s {limits.run_timeout_sec}s "
        f"{binary} --secret-file {secret} --cwd /app "
        f"--base-url {base} "
        f"--max-steps {limits.max_steps} "
        f"--max-output-tokens {limits.max_output_tokens} "
        f"--session-token-budget {limits.session_token_budget} "
        f"--context-chars {limits.context_chars} "
        f"--tool-output-chars {limits.tool_output_chars} "
        f"--prompt {prompt} "
        f"2>&1 </dev/null | tail -c {limits.log_bytes} > {log}"
    )


def parse_usage_log(value: str) -> dict[str, int]:
    """Extract the latest cumulative CLI telemetry without guessing token splits."""
    clean = _strip_terminal_controls(value)
    latest: dict[str, int] = {}
    for line in clean.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "usage":
            continue
        mappings = {
            "promptTokens": "request_prompt_tokens",
            "completionTokens": "request_completion_tokens",
            "totalTokens": "request_total_tokens",
            "cachedTokens": "request_cached_tokens",
            "sessionPromptTokens": "session_prompt_tokens",
            "sessionCompletionTokens": "session_completion_tokens",
            "sessionTotalTokens": "session_total_tokens",
            "sessionCachedTokens": "session_cached_tokens",
            "requestCount": "request_count",
        }
        latest = {
            target: raw
            for source, target in mappings.items()
            if isinstance((raw := event.get(source)), int) and raw >= 0
        }
    if latest:
        return latest

    for match in _USAGE_LINE.finditer(clean):
        request = int(match.group("request"))
        session = (
            int(match.group("session")) if match.group("session") else request
        )
        latest = {
            "request_total_tokens": request,
            "session_total_tokens": session,
        }
        if match.group("request_cached"):
            latest["request_cached_tokens"] = int(match.group("request_cached"))
        if match.group("session_cached"):
            latest["session_cached_tokens"] = int(match.group("session_cached"))
    return latest


class KraterProAgent(BaseInstalledAgent):
    """Run a self-contained Krater Pro bundle under Pier 0.3."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        *args,
        bundle_path: str,
        product_skills_dir: str | None = None,
        dry_run: bool = False,
        run_timeout_sec: int = 5_100,
        max_steps: int = 96,
        max_output_tokens: int = 8_192,
        session_token_budget: int = 400_000,
        context_chars: int = 180_000,
        tool_output_chars: int = 24_000,
        log_bytes: int = 524_288,
        **kwargs,
    ):
        requested_model = kwargs.get("model_name") or EXPECTED_MODEL
        if requested_model != EXPECTED_MODEL:
            raise ValueError(
                f"DeepSWE runs require the exact model {EXPECTED_MODEL!r}; "
                f"received {requested_model!r}"
            )
        kwargs["model_name"] = EXPECTED_MODEL
        super().__init__(*args, **kwargs)

        self._bundle_path = _validate_local_file(
            bundle_path,
            label="Krater Pro bundle",
            maximum_bytes=32 * 1024 * 1024,
        )
        default_skills = Path(__file__).resolve().parents[2] / "skills"
        self._product_skills_dir = _validate_local_directory(
            product_skills_dir or default_skills,
            label="Krater Pro skills directory",
        )
        self._dry_run = bool(dry_run)
        self._task_base_commit: str | None = None
        self._limits = RuntimeLimits(
            run_timeout_sec=_bounded_int(
                run_timeout_sec,
                name="run_timeout_sec",
                minimum=60,
                maximum=5_200,
            ),
            max_steps=_bounded_int(
                max_steps, name="max_steps", minimum=1, maximum=128
            ),
            max_output_tokens=_bounded_int(
                max_output_tokens,
                name="max_output_tokens",
                minimum=256,
                maximum=65_536,
            ),
            session_token_budget=_bounded_int(
                session_token_budget,
                name="session_token_budget",
                minimum=1_000,
                maximum=10_000_000,
            ),
            context_chars=_bounded_int(
                context_chars,
                name="context_chars",
                minimum=10_000,
                maximum=2_000_000,
            ),
            tool_output_chars=_bounded_int(
                tool_output_chars,
                name="tool_output_chars",
                minimum=1_000,
                maximum=250_000,
            ),
            log_bytes=_bounded_int(
                log_bytes,
                name="log_bytes",
                minimum=16_384,
                maximum=4 * 1024 * 1024,
            ),
        )
        self._base_url = _validate_base_url(
            self._get_env("KRATER_BASE_URL") or DEFAULT_BASE_URL
        )

    @staticmethod
    def name() -> str:
        return "krater-pro"

    def install_spec(self) -> AgentInstallSpec:
        """Verify prerequisites already supplied by DeepSWE's common base image."""
        check = (
            "set -euo pipefail; "
            "command -v node >/dev/null; "
            "command -v git >/dev/null; "
            "command -v timeout >/dev/null; "
            "command -v tail >/dev/null; "
            "node -e 'const [a,b]=process.versions.node.split(\".\").map(Number);"
            "const ok=(a===20&&b>=19)||(a===22&&b>=12)||a>22;"
            "if(!ok)process.exit(1)'"
        )
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self.version(),
            steps=[InstallStep(user="root", run=check)],
            verification_command="node --version",
            metadata={
                "distribution": "host-built self-contained bundle",
                "runtime_network": "Krater API only",
            },
        )

    def network_allowlist(self) -> NetworkAllowlist:
        hostname = urlparse(self._base_url).hostname
        assert hostname is not None
        return NetworkAllowlist(domains=[hostname])

    def get_version_command(self) -> str | None:
        return f"{shlex.quote(REMOTE_BINARY)} --version"

    @staticmethod
    def _redact(value: str | None, secrets: tuple[str, ...]) -> str:
        text = value or ""
        for secret in secrets:
            if secret:
                text = text.replace(secret, "[redacted]")
        return text

    async def _exec_safe(
        self,
        environment: BaseEnvironment,
        *,
        command: str,
        label: str,
        user: str | int | None = None,
        timeout_sec: int | None = None,
        secrets: tuple[str, ...] = (),
    ) -> ExecResult:
        """Execute without BaseInstalledAgent's environment-value debug logging."""
        self.logger.debug("Krater Pro adapter phase: %s", label)
        result = await environment.exec(
            command=command,
            user=user,
            cwd=(
                "/app"
                if label in {"capture task base", "prepare git", "finalize git"}
                else None
            ),
            timeout_sec=timeout_sec,
        )
        if result.return_code != 0:
            stdout = self._redact(result.stdout, secrets)[-2_000:]
            stderr = self._redact(result.stderr, secrets)[-2_000:]
            raise NonZeroAgentExitCodeError(
                f"Krater Pro adapter phase {label!r} failed "
                f"(exit {result.return_code}). stdout: {stdout or 'None'}; "
                f"stderr: {stderr or 'None'}"
            )
        return result

    async def setup(self, environment: BaseEnvironment) -> None:
        """Install the bundle and skills without package-registry access."""
        await self._exec_safe(
            environment,
            command=f"mkdir -p {REMOTE_ROOT}/dist {REMOTE_SKILLS} /installed-agent",
            user="root",
            label="create install directories",
            timeout_sec=30,
        )

        is_preinstalled = (
            environment.agent_install_spec is not None
            and environment.agent_install_spec.agent_name == self.name()
        )
        if not is_preinstalled:
            for step in self.install_spec().steps:
                await self._exec_safe(
                    environment,
                    command=step.run,
                    user="root" if step.user == "root" else None,
                    label="verify runtime prerequisites",
                    timeout_sec=120,
                )

        await environment.upload_file(self._bundle_path, REMOTE_BUNDLE)
        await environment.upload_dir(self._product_skills_dir, REMOTE_SKILLS)
        version_result = await self._exec_safe(
            environment,
            command=(
                "node -e 'const [a,b]=process.versions.node.split(\".\").map(Number);"
                "const ok=(a===20&&b>=19)||(a===22&&b>=12)||a>22;"
                "if(!ok)process.exit(1)' && "
                f"chmod 0755 {shlex.quote(REMOTE_BUNDLE)} && "
                f"ln -sfn {shlex.quote(REMOTE_BUNDLE)} "
                f"{shlex.quote(REMOTE_BINARY)} && "
                f"{shlex.quote(REMOTE_BINARY)} --version"
            ),
            user="root",
            label="install and verify bundle",
            timeout_sec=120,
        )
        if self._version is None and version_result.stdout:
            self._version = self.parse_version(version_result.stdout)
        base_result = await self._exec_safe(
            environment,
            command=(
                "set -euo pipefail; "
                "git rev-parse --is-inside-work-tree >/dev/null; "
                "test -z \"$(git -c core.fsmonitor=false status "
                "--porcelain=v1 --untracked-files=all)\"; "
                "base=$(git rev-parse HEAD); "
                "printf '%s' \"$base\""
            ),
            label="capture task base",
            timeout_sec=60,
        )
        captured_base = (base_result.stdout or "").strip()
        if not _GIT_OID.fullmatch(captured_base):
            raise NonZeroAgentExitCodeError(
                "Krater Pro could not capture the task's starting Git revision"
            )
        self._task_base_commit = captured_base

    async def _prepare_git(self, environment: BaseEnvironment) -> str:
        if not self._task_base_commit or not _GIT_OID.fullmatch(
            self._task_base_commit
        ):
            raise ValueError("DeepSWE task base was not captured during setup")
        expected_base = shlex.quote(self._task_base_commit)
        result = await self._exec_safe(
            environment,
            command=(
                "set -euo pipefail; "
                "git rev-parse --is-inside-work-tree >/dev/null; "
                "git config core.hooksPath /dev/null; "
                "git config user.name 'Krater Pro Benchmark'; "
                "git config user.email 'benchmark@krater.local'; "
                "if [ -n \"$(git status --porcelain=v1 --untracked-files=all)\" ]; then "
                "echo 'task repository was dirty before agent execution' >&2; exit 1; "
                "fi; "
                f"base={expected_base}; "
                "git cat-file -e \"$base^{commit}\"; "
                f"git switch -C {BRANCH_NAME} \"$base\" >/dev/null; "
                "test \"$(git rev-parse HEAD)\" = \"$base\"; "
                "test -z \"$(git status --porcelain=v1 --untracked-files=all)\"; "
                "printf '%s' \"$base\""
            ),
            label="prepare git",
            timeout_sec=60,
        )
        base_commit = (result.stdout or "").strip()
        if not _GIT_OID.fullmatch(base_commit):
            raise NonZeroAgentExitCodeError(
                "Krater Pro could not establish a valid starting Git revision"
            )
        return base_commit

    async def _finalize_git(
        self,
        environment: BaseEnvironment,
        base_commit: str,
    ) -> None:
        if not _GIT_OID.fullmatch(base_commit):
            raise ValueError("Invalid DeepSWE base commit")
        base = shlex.quote(base_commit)
        await self._exec_safe(
            environment,
            command=(
                "set -euo pipefail; "
                f"test \"$(git -c core.fsmonitor=false branch --show-current)\" = "
                f"{shlex.quote(BRANCH_NAME)}; "
                f"git -c core.fsmonitor=false cat-file -e {base}^{{commit}}; "
                "git -c core.hooksPath=/dev/null add -A; "
                "if ! git -c core.fsmonitor=false diff --cached --quiet; then "
                "git -c core.hooksPath=/dev/null commit --no-gpg-sign "
                "-m 'Krater Pro DeepSWE solution' >/dev/null; "
                "fi; "
                f"git -c core.fsmonitor=false merge-base --is-ancestor {base} HEAD; "
                "if [ -n \"$(git -c core.fsmonitor=false status --porcelain=v1 "
                "--untracked-files=all)\" ]; then "
                "echo 'working tree remained dirty after final commit' >&2; exit 1; "
                "fi"
            ),
            label="finalize git",
            timeout_sec=120,
        )

    async def _install_secret(
        self,
        environment: BaseEnvironment,
        secret: str,
    ) -> None:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=True) as handle:
            handle.write(secret)
            handle.flush()
            os.chmod(handle.name, 0o600)
            await environment.upload_file(handle.name, REMOTE_SECRET)

        ownership = ""
        if environment.default_user is not None:
            ownership = (
                f"chown {shlex.quote(str(environment.default_user))} "
                f"{shlex.quote(REMOTE_SECRET)} && "
            )
        await self._exec_safe(
            environment,
            command=(
                f"{ownership}chmod 0600 {shlex.quote(REMOTE_SECRET)}"
            ),
            user="root",
            label="install runtime secret",
            timeout_sec=30,
            secrets=(secret,),
        )

    async def _remove_secret(self, environment: BaseEnvironment) -> None:
        try:
            result = await environment.exec(
                command=f"rm -f {shlex.quote(REMOTE_SECRET)}",
                user="root",
                timeout_sec=30,
            )
            if result.return_code != 0:
                self.logger.warning(
                    "Could not remove Krater Pro runtime secret file (exit %s)",
                    result.return_code,
                )
        except Exception:
            self.logger.warning("Could not remove Krater Pro runtime secret file")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if self._dry_run:
            await self._exec_safe(
                environment,
                command=(
                    "set -euo pipefail; "
                    "test -d /app/.git; "
                    f"{shlex.quote(REMOTE_BINARY)} --version >/dev/null; "
                    f"printf '%s\\n' "
                    f"{shlex.quote('infrastructure-only: Krater Pro bundle and /app are ready')} "
                    f"> {shlex.quote(REMOTE_LOG)}"
                ),
                label="infrastructure dry run",
                timeout_sec=60,
            )
            context.metadata = {
                "krater_pro": {
                    "status": "infrastructure-only",
                    "model": EXPECTED_MODEL,
                    "paid_inference": False,
                }
            }
            return

        if "KRATER_API_KEY" in self._extra_env:
            raise ValueError(
                "KRATER_API_KEY must remain in Pier's host environment; "
                "do not configure it with --agent-env."
            )
        secret = (os.environ.get("KRATER_API_KEY") or "").strip()
        if not secret:
            raise ValueError(
                "KRATER_API_KEY is required for a live DeepSWE run. "
                "Load it into Pier's host process with --env-file or export it; "
                "never place it in --agent-env or a job config."
            )

        base_commit = await self._prepare_git(environment)
        result: ExecResult | None = None
        run_error: Exception | None = None
        finalize_error: Exception | None = None
        try:
            await self._install_secret(environment, secret)
            command = build_agent_command(
                instruction,
                base_url=self._base_url,
                limits=self._limits,
            )
            self.logger.info(
                "Running Krater Pro with model %s in /app (bounded to %ss)",
                EXPECTED_MODEL,
                self._limits.run_timeout_sec,
            )
            result = await environment.exec(
                command=command,
                cwd="/app",
                timeout_sec=self._limits.run_timeout_sec + 30,
            )
        except Exception as exc:
            run_error = exc
        finally:
            await self._remove_secret(environment)
            try:
                await self._finalize_git(environment, base_commit)
            except Exception as exc:
                finalize_error = exc

        context.metadata = {
            "krater_pro": {
                "status": "completed" if result and result.return_code == 0 else "failed",
                "model": EXPECTED_MODEL,
                "base_commit": base_commit,
                "branch": BRANCH_NAME,
                "log_tail_limit_bytes": self._limits.log_bytes,
            }
        }
        if finalize_error is not None:
            if run_error is not None:
                raise finalize_error from run_error
            raise finalize_error
        if run_error is not None:
            raise NonZeroAgentExitCodeError(
                "Krater Pro execution failed before a normal exit; inspect "
                f"{REMOTE_LOG}. Any partial changes were committed for capture."
            ) from run_error
        if result is None or result.return_code != 0:
            code = result.return_code if result is not None else "unknown"
            raise NonZeroAgentExitCodeError(
                f"Krater Pro exited with code {code}; inspect {REMOTE_LOG}. "
                "Any partial workspace changes were committed for artifact capture."
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Populate only telemetry Krater Pro reports; never invent token splits."""
        log_path = self.logs_dir / Path(REMOTE_LOG).name
        if not log_path.is_file():
            return
        try:
            text = log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return

        usage = parse_usage_log(text)
        clean = _strip_terminal_controls(text)
        tool_steps = clean.count('"type":"tool"') or clean.count("◇ ")
        done_steps: int | None = None
        for line in clean.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(event, dict)
                and event.get("type") == "done"
                and isinstance(event.get("steps"), int)
            ):
                done_steps = event["steps"]
        metadata = dict(context.metadata or {})
        krater_metadata = dict(metadata.get("krater_pro") or {})
        krater_metadata.update(usage)
        krater_metadata["observed_tool_calls_in_log_tail"] = tool_steps
        metadata["krater_pro"] = krater_metadata
        context.metadata = metadata
        if "session_prompt_tokens" in usage:
            context.n_input_tokens = usage["session_prompt_tokens"]
        if "session_completion_tokens" in usage:
            context.n_output_tokens = usage["session_completion_tokens"]
        if "session_cached_tokens" in usage:
            context.n_cache_tokens = usage["session_cached_tokens"]
        if done_steps is not None:
            context.n_agent_steps = done_steps
        elif tool_steps:
            context.n_agent_steps = tool_steps

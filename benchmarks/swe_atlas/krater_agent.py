"""Harbor v0.18 custom agent that runs Krater Pro on SWE-Atlas tasks."""

from __future__ import annotations

import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .agent_core import (
    EXACT_BASE_URL,
    EXACT_MODEL,
    NODE_VERSION_GATE_JS,
    build_payload_manifest,
    parse_usage_log,
    resolve_bundle_path,
    resolve_skills_path,
    serialize_payload_manifest,
    submission_addendum,
    validate_base_url,
    validate_model,
    validate_task_kind,
    workspace_discovery_shell,
)

_REMOTE_BUNDLE = "/installed-agent/dist/krater-pro.mjs"
_REMOTE_SKILLS = "/installed-agent/skills"
_REMOTE_INSTRUCTION = "/installed-agent/instruction.txt"
_REMOTE_SECRET = "/run/krater-pro-api-key"
_REMOTE_MANIFEST = "/installed-agent/payload-manifest.json"
_REMOTE_VERIFIER = "/installed-agent/payload-verify.mjs"
_OUTPUT_LOG = "krater-pro.txt"
_GIT_OID = re.compile(r"^[0-9a-f]{40,64}$")


class KraterProAtlasAgent(BaseInstalledAgent):
    """Offline-installed Krater Pro adapter for QA, test-writing, and refactoring."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        task_kind: str = "qa",
        bundle_path: str | None = None,
        skills_path: str | None = None,
        *args,
        **kwargs,
    ):
        self.task_kind = validate_task_kind(task_kind)
        self.bundle_path = resolve_bundle_path(
            bundle_path or os.environ.get("KRATER_PRO_BUNDLE")
        )
        product_root = Path(__file__).resolve().parents[2]
        self.skills_path = resolve_skills_path(
            skills_path or os.environ.get("KRATER_PRO_SKILLS_DIR"),
            product_root / "skills",
        )
        self.payload_manifest = build_payload_manifest(
            self.bundle_path,
            self.skills_path,
        )
        self.payload_verifier = Path(__file__).with_name("payload_verify.mjs")
        if not self.payload_verifier.is_file():
            raise ValueError(
                f"Krater Pro payload verifier is missing: {self.payload_verifier}"
            )
        validate_model(model_name)
        validate_base_url(EXACT_BASE_URL)
        super().__init__(
            logs_dir=logs_dir,
            model_name=model_name,
            *args,
            **kwargs,
        )

    @staticmethod
    @override
    def name() -> str:
        return "krater-pro"

    @override
    def get_version_command(self) -> str | None:
        return f"node {shlex.quote(_REMOTE_BUNDLE)} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        node_check = await environment.exec(
            command=(
                "command -v node >/dev/null 2>&1 && "
                f"node -e {shlex.quote(NODE_VERSION_GATE_JS)}"
            ),
            user=environment.default_user,
        )
        if node_check.return_code != 0:
            raise RuntimeError(
                "The SWE-Atlas image needs Node.js ^20.19.0 or >=22.12.0. "
                "Krater Pro intentionally does not download runtimes during a "
                "network-restricted benchmark run."
            )

        await self.exec_as_root(
            environment,
            command=(
                "mkdir -p /installed-agent/dist /installed-agent/skills "
                "/logs/agent && chmod 777 /logs/agent"
            ),
        )
        await environment.upload_file(self.bundle_path, _REMOTE_BUNDLE)
        await environment.upload_dir(self.skills_path, _REMOTE_SKILLS)
        setup_dir = self.logs_dir / "setup"
        setup_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = setup_dir / "payload-manifest.json"
        manifest_path.write_text(
            serialize_payload_manifest(self.payload_manifest),
            encoding="utf-8",
        )
        await environment.upload_file(manifest_path, _REMOTE_MANIFEST)
        await environment.upload_file(self.payload_verifier, _REMOTE_VERIFIER)
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 755 {shlex.quote(_REMOTE_BUNDLE)} "
                f"{shlex.quote(_REMOTE_VERIFIER)} && "
                f"chmod 644 {shlex.quote(_REMOTE_MANIFEST)}"
            ),
        )
        verification = await environment.exec(
            command=f"node {shlex.quote(_REMOTE_VERIFIER)}",
            user=environment.default_user,
        )
        if verification.return_code != 0:
            raise RuntimeError(
                "Uploaded Krater Pro bundle or skills failed SHA-256 verification: "
                f"{(verification.stderr or verification.stdout or 'no detail')[-1000:]}"
            )

        bundle = self.payload_manifest["bundle"]
        skills = self.payload_manifest["skills"]
        assert isinstance(bundle, dict) and isinstance(skills, dict)
        (setup_dir / "bundle.sha256").write_text(
            f"{bundle['sha256']}  krater-pro.mjs\n",
            encoding="utf-8",
        )
        (setup_dir / "skills.sha256").write_text(
            f"{skills['sha256']}  skills\n",
            encoding="utf-8",
        )

    def _host_api_key(self) -> str:
        if "KRATER_API_KEY" in self.extra_env:
            raise RuntimeError(
                "KRATER_API_KEY must remain in Harbor's host environment; "
                "remove it from AgentConfig.env."
            )
        secret = (os.environ.get("KRATER_API_KEY") or "").strip()
        if not secret:
            raise RuntimeError(
                "KRATER_API_KEY is required in the Harbor host environment."
            )
        return secret

    async def _install_secret(
        self,
        environment: BaseEnvironment,
        secret: str,
    ) -> None:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=True) as handle:
            handle.write(secret)
            handle.flush()
            os.chmod(handle.name, 0o600)
            await environment.upload_file(handle.name, _REMOTE_SECRET)

        ownership = ""
        if environment.default_user is not None:
            ownership = (
                f"chown {shlex.quote(str(environment.default_user))} "
                f"{shlex.quote(_REMOTE_SECRET)} && "
            )
        result = await environment.exec(
            command=(
                f"{ownership}chmod 0600 {shlex.quote(_REMOTE_SECRET)}"
            ),
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError("Could not secure the Krater API key handoff file")

    async def _remove_secret(self, environment: BaseEnvironment) -> None:
        try:
            result = await environment.exec(
                command=f"rm -f {shlex.quote(_REMOTE_SECRET)}",
                user="root",
            )
            if result.return_code != 0:
                self.logger.warning(
                    "Could not remove the Krater API key handoff file (exit %s)",
                    result.return_code,
                )
        except Exception:
            self.logger.warning("Could not remove the Krater API key handoff file")

    async def _discover_workspace(
        self,
        environment: BaseEnvironment,
    ) -> tuple[str, str]:
        result = await environment.exec(
            command=f"set -euo pipefail\n{workspace_discovery_shell()}",
            user=environment.default_user,
        )
        if result.return_code != 0:
            raise RuntimeError(
                "Could not establish a clean SWE-Atlas starting revision: "
                f"{(result.stderr or result.stdout or 'no detail')[-1000:]}"
            )
        lines = (result.stdout or "").splitlines()
        if (
            len(lines) != 2
            or not lines[0].startswith("/")
            or "\0" in lines[0]
            or not _GIT_OID.fullmatch(lines[1])
        ):
            raise RuntimeError(
                "SWE-Atlas workspace discovery returned an invalid path or revision"
            )
        return lines[0], lines[1]

    def _submission_capture_shell(self, workspace: str, base: str) -> str:
        workspace_value = shlex.quote(workspace)
        base_value = shlex.quote(base)
        diff = f"""
workspace={workspace_value}
base={base_value}
git -C "$workspace" cat-file -e "$base^{{commit}}"
{{
  git -C "$workspace" -c core.fsmonitor=false -c diff.external= \
    diff --binary --no-ext-diff --no-textconv "$base" --
  while IFS= read -r -d '' file; do
    git -C "$workspace" -c core.fsmonitor=false -c diff.external= \
      diff --no-index --binary --no-ext-diff --no-textconv -- \
      /dev/null "$workspace/$file" || status=$?
    if [ "${{status:-0}}" -ne 0 ] && [ "${{status:-0}}" -ne 1 ]; then
      exit "$status"
    fi
    unset status
  done < <(git -C "$workspace" -c core.fsmonitor=false \
    ls-files --others --exclude-standard -z)
}} > /logs/agent/submission.diff
git -C "$workspace" -c core.fsmonitor=false status --porcelain=v1 \
  > /logs/agent/submission.status
""".strip()

        if self.task_kind == "qa":
            return f"""
workspace={workspace_value}
base={base_value}
test "$(git -C "$workspace" rev-parse HEAD)" = "$base"
git -C "$workspace" -c core.fsmonitor=false -c diff.external= \
  diff --quiet --no-ext-diff --no-textconv "$base" --
test -z "$(git -C "$workspace" -c core.fsmonitor=false \
  status --porcelain=v1 --untracked-files=all)"
test -s /logs/agent/answer.txt
test "$(grep -c '^<<FINAL_ANSWER>>$' /logs/agent/answer.txt)" -eq 2
""".strip()

        required = (
            "\ntest -s /logs/agent/manifest.txt\n"
            "test \"$(grep -c '^<<TEST_MANIFEST>>$' "
            "/logs/agent/manifest.txt)\" -eq 2"
            if self.task_kind == "tw"
            else "\ntest -s /logs/agent/submission.diff"
        )
        return f"{diff}{required}"

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        secret = self._host_api_key()
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        local_instruction = self.logs_dir / "instruction.txt"
        local_instruction.write_text(
            f"{instruction.rstrip()}\n{submission_addendum(self.task_kind)}"
        )
        await environment.upload_file(local_instruction, _REMOTE_INSTRUCTION)
        workspace, base_commit = await self._discover_workspace(environment)

        command = f"""
set -euo pipefail
workspace={shlex.quote(workspace)}
cd "$workspace"
node {shlex.quote(_REMOTE_BUNDLE)} \
  --secret-file {shlex.quote(_REMOTE_SECRET)} \
  --prompt-file {shlex.quote(_REMOTE_INSTRUCTION)} \
  --base-url {shlex.quote(EXACT_BASE_URL)} \
  --cwd "$workspace" \
  --max-steps 128 \
  --max-output-tokens 16384 \
  --session-token-budget 1000000 \
  --context-chars 240000 \
  --tool-output-chars 32000 \
  2>&1 | tee /logs/agent/{_OUTPUT_LOG}
"""
        try:
            await self._install_secret(environment, secret)
            await self.exec_as_agent(environment, command=command, timeout_sec=10_800)
        finally:
            await self._remove_secret(environment)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail\n"
                f"{self._submission_capture_shell(workspace, base_commit)}"
            ),
        )
        context.metadata = {
            **(context.metadata or {}),
            "krater_model": EXACT_MODEL,
            "swe_atlas_kind": self.task_kind,
            "base_commit": base_commit,
        }

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / _OUTPUT_LOG
        if not output_path.is_file():
            return
        usage = parse_usage_log(output_path.read_text(errors="replace"))
        context.n_cache_tokens = usage["cached_tokens"]
        context.metadata = {
            **(context.metadata or {}),
            "reported_total_tokens": usage["total_tokens"],
            "krater_model": EXACT_MODEL,
            "swe_atlas_kind": self.task_kind,
        }

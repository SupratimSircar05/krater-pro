#!/usr/bin/env python3
"""Build a self-contained Krater Pro CLI and run it through Pier/DeepSWE safely."""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

EXPECTED_MODEL = "moonshotai/kimi-k3"
EXPECTED_UPSTREAM_COMMIT = "e016041a6ccf8da29906afc9a3f5a8df940a1f78"
ADAPTER_IMPORT = "krater_pier_agent:KraterProAgent"


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def find_pier(explicit: str | None = None) -> Path:
    candidates = [
        Path(explicit).expanduser() if explicit else None,
        Path(shutil.which("pier")) if shutil.which("pier") else None,
        Path.home() / ".local/bin/pier",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(
        "Pier was not found. Install the pinned adapter runtime with "
        "`uv tool install datacurve-pier==0.3.0` or pass --pier."
    )


def validate_official_checkout(
    tasks_root: Path,
    *,
    expected_commit: str = EXPECTED_UPSTREAM_COMMIT,
) -> None:
    """Require the pinned checkout with no Git-visible changes before discovery."""

    checkout = tasks_root.parent
    try:
        completed = subprocess.run(
            [
                "git",
                "-c",
                "core.fsmonitor=false",
                "-C",
                str(checkout),
                "rev-parse",
                "--show-toplevel",
                "HEAD",
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
        )
        lines = completed.stdout.splitlines()
        if len(lines) != 2:
            raise ValueError("Could not resolve the DeepSWE checkout and revision")
        repository = Path(lines[0]).resolve()
        revision = lines[1].strip()
        if repository != checkout or repository / "tasks" != tasks_root:
            raise ValueError(
                f"DeepSWE tasks must be the tasks/ directory of {checkout}"
            )
        if revision != expected_commit:
            raise ValueError(
                "Unsupported DeepSWE checkout: expected "
                f"{expected_commit}, found {revision}."
            )
        dirty = subprocess.run(
            [
                "git",
                "-c",
                "core.fsmonitor=false",
                "-C",
                str(checkout),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError(
            f"Could not validate the official DeepSWE checkout at {checkout}"
        ) from exc
    if dirty:
        raise ValueError(
            "The official DeepSWE checkout must be clean before evaluation; "
            f"found: {dirty.splitlines()[0]}"
        )


def validate_deep_swe_root(
    value: str | Path,
    *,
    verify_checkout: bool = True,
) -> Path:
    root = Path(value).expanduser().resolve()
    required = (
        root / "dataset.toml",
        root / "manifest.json",
    )
    if not root.is_dir() or any(not item.is_file() for item in required):
        raise ValueError(
            f"Not a DeepSWE tasks directory: {root}. Expected dataset.toml "
            "and manifest.json."
        )
    if verify_checkout:
        validate_official_checkout(root)
    return root


def validate_task_names(tasks_root: Path, names: list[str], run_all: bool) -> None:
    if run_all and names:
        raise ValueError("--all cannot be combined with --task")
    if not run_all and not names:
        raise ValueError("Choose at least one --task, or pass --all explicitly")
    for name in names:
        if "/" in name or name in {"", ".", ".."}:
            raise ValueError(f"Invalid DeepSWE task ID: {name!r}")
        task = tasks_root / name
        if not (task / "task.toml").is_file():
            raise ValueError(f"Unknown DeepSWE task ID: {name}")


def build_bundle(output: Path, root: Path | None = None) -> Path:
    root = (root or repository_root()).resolve()
    esbuild = root / "node_modules/.bin/esbuild"
    source = root / "benchmarks/deep_swe/agent_entry.ts"
    if not esbuild.is_file() or not os.access(esbuild, os.X_OK):
        raise RuntimeError(
            f"Missing {esbuild}. Run `npm install` in the Krater Pro checkout."
        )
    if not source.is_file():
        raise RuntimeError(f"Missing Krater Pro CLI source: {source}")
    validate_host_node()
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(esbuild),
        str(source),
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20.19",
        (
            "--banner:js=import { createRequire as __kraterCreateRequire } "
            'from "node:module"; const require = '
            "__kraterCreateRequire(import.meta.url);"
        ),
        f"--outfile={output}",
        "--log-level=warning",
    ]
    completed = subprocess.run(
        command,
        cwd=root,
        check=False,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout)[-4_000:]
        raise RuntimeError(f"Could not bundle Krater Pro: {detail}")
    output.chmod(0o755)
    smoke = subprocess.run(
        ["node", str(output), "--version"],
        cwd=root,
        check=False,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if smoke.returncode != 0 or not smoke.stdout.strip():
        raise RuntimeError(
            "The generated Krater Pro bundle failed its offline --version smoke test"
        )
    return output.resolve()


def validate_host_node() -> str:
    """Enforce the same Node range declared by Krater Pro's package metadata."""

    try:
        completed = subprocess.run(
            [
                "node",
                "-e",
                (
                    "const [major,minor]=process.versions.node.split('.').map(Number);"
                    "const ok=(major===20&&minor>=19)"
                    "||(major===22&&minor>=12)||major>22;"
                    "if(!ok)process.exit(1);process.stdout.write(process.versions.node)"
                ),
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("Node.js is required to build the DeepSWE bundle") from exc
    if completed.returncode != 0:
        raise RuntimeError(
            "Krater Pro requires Node.js ^20.19.0 or >=22.12.0; "
            "Node 21 and Node 22.0-22.11 are rejected."
        )
    return completed.stdout.strip()


def build_pier_command(
    *,
    pier: Path,
    tasks_root: Path,
    bundle: Path,
    skills_dir: Path,
    task_names: list[str],
    run_all: bool,
    jobs_dir: Path,
    env_file: Path | None,
    infrastructure_only: bool,
    n_concurrent: int,
) -> list[str]:
    command = [
        str(pier),
        "run",
        "--path",
        str(tasks_root),
        "--agent-import-path",
        ADAPTER_IMPORT,
        "--model",
        EXPECTED_MODEL,
        "--agent-kwarg",
        f"bundle_path={bundle}",
        "--agent-kwarg",
        f"product_skills_dir={skills_dir}",
        "--jobs-dir",
        str(jobs_dir),
        "--n-concurrent",
        str(n_concurrent),
        "--max-retries",
        "0",
        "--yes",
    ]
    for task in task_names:
        command.extend(["--include-task-name", task])
    if infrastructure_only:
        command.extend(
            [
                "--agent-kwarg",
                "dry_run=true",
                "--disable-verification",
            ]
        )
    else:
        if env_file is not None:
            command.extend(["--env-file", str(env_file)])
    if run_all:
        # No include filter means the complete official dataset.
        pass
    return command


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Build Krater Pro as an offline bundle and run official DeepSWE tasks "
            "through Pier 0.3."
        )
    )
    result.add_argument(
        "--tasks-root",
        required=True,
        help="Path to the cloned deep-swe/tasks directory",
    )
    result.add_argument("--task", action="append", default=[], help="Task ID")
    result.add_argument(
        "--all",
        action="store_true",
        help="Run all official tasks (explicit because this can be expensive)",
    )
    mode = result.add_mutually_exclusive_group()
    mode.add_argument(
        "--execute",
        action="store_true",
        help="Run paid Kimi K3 inference and official verification",
    )
    mode.add_argument(
        "--infrastructure-only",
        action="store_true",
        help="Start the task container and verify the bundle without inference",
    )
    result.add_argument(
        "--bundle",
        help="Use an existing self-contained .mjs bundle instead of building one",
    )
    result.add_argument("--pier", help="Path to the Pier 0.3 executable")
    result.add_argument(
        "--env-file",
        default=str(repository_root() / ".env"),
        help=(
            "Env file loaded only into Pier's host process; no value is added "
            "to agent.env or a task-container command"
        ),
    )
    result.add_argument(
        "--jobs-dir",
        default=str(repository_root() / "benchmarks/deep_swe/results"),
    )
    result.add_argument("--n-concurrent", type=int, default=1)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        tasks_root = validate_deep_swe_root(args.tasks_root)
        validate_task_names(tasks_root, args.task, args.all)
        if args.n_concurrent < 1 or args.n_concurrent > 16:
            raise ValueError("--n-concurrent must be from 1 to 16")
        pier = find_pier(args.pier)
        root = repository_root()
        skills = root / "skills"
        if not skills.is_dir():
            raise ValueError(f"Krater Pro skills directory is missing: {skills}")
        env_file = Path(args.env_file).expanduser().resolve()
        if args.execute and not env_file.is_file() and not os.environ.get(
            "KRATER_API_KEY"
        ):
            raise ValueError(
                "A live run needs KRATER_API_KEY in the environment or --env-file"
            )

        bundle = (
            Path(args.bundle).expanduser().resolve()
            if args.bundle
            else build_bundle(
                root / ".krater/benchmarks/deep-swe/krater-pro.mjs",
                root,
            )
        )
        if not bundle.is_file():
            raise ValueError(f"Krater Pro bundle does not exist: {bundle}")
        if args.bundle:
            validate_host_node()
            smoke = subprocess.run(
                ["node", str(bundle), "--version"],
                cwd=root,
                check=False,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if smoke.returncode != 0:
                raise ValueError("The supplied bundle failed its --version smoke test")
        command = build_pier_command(
            pier=pier,
            tasks_root=tasks_root,
            bundle=bundle,
            skills_dir=skills.resolve(),
            task_names=args.task,
            run_all=args.all,
            jobs_dir=Path(args.jobs_dir).expanduser().resolve(),
            env_file=env_file if env_file.is_file() else None,
            infrastructure_only=args.infrastructure_only,
            n_concurrent=args.n_concurrent,
        )

        print(f"Model: {EXPECTED_MODEL}")
        print(f"Tasks: {'all official tasks' if args.all else ', '.join(args.task)}")
        if not args.execute and not args.infrastructure_only:
            print("Plan only; no Docker or paid inference was started.")
            print(shlex.join(command))
            return 0

        mode = (
            "infrastructure-only (no inference)"
            if args.infrastructure_only
            else "live inference and official verification"
        )
        print(f"Mode: {mode}")
        child_env = dict(os.environ)
        adapter_dir = str(Path(__file__).resolve().parent)
        existing_pythonpath = child_env.get("PYTHONPATH")
        child_env["PYTHONPATH"] = (
            f"{adapter_dir}{os.pathsep}{existing_pythonpath}"
            if existing_pythonpath
            else adapter_dir
        )
        completed = subprocess.run(
            command,
            cwd=root,
            env=child_env,
            check=False,
            stdin=subprocess.DEVNULL,
        )
        return completed.returncode
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

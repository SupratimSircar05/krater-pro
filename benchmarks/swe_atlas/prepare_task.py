#!/usr/bin/env python3
"""Copy one official SWE-Atlas task and enforce its agent network allowlist."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

from benchmarks.swe_atlas.agent_core import KRATER_API_HOST, validate_task_kind

EXPECTED_UPSTREAM_COMMIT = "6de82c3603fb9e254170b440d7560441eb257176"
SMOKE_TASKS = {
    "qa": "task-6905333b74f22949d97ba9cc",
    "tw": "task-6902ef3ab97fe23e2ad2722c",
    "rf": "task-69d196f015a150488265afc2",
}

_SECTION = re.compile(r"^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$")
_KEY = re.compile(r"^\s*(network_mode|allowed_hosts)\s*=")


def upstream_commit(source_root: Path) -> str:
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-C",
            str(source_root),
            "rev-parse",
            "HEAD",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.stdout.strip()


def validate_upstream_checkout(
    source_root: Path,
    *,
    expected_commit: str = EXPECTED_UPSTREAM_COMMIT,
) -> str:
    """Require the exact revision with no tracked or non-ignored untracked changes."""

    actual = upstream_commit(source_root)
    if actual != expected_commit:
        raise ValueError(
            "Unsupported SWE-Atlas checkout: expected "
            f"{expected_commit}, found {actual}."
        )
    try:
        dirty = subprocess.run(
            [
                "git",
                "-c",
                "core.fsmonitor=false",
                "-C",
                str(source_root),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError(
            f"Could not inspect the SWE-Atlas checkout at {source_root}"
        ) from exc
    if dirty:
        raise ValueError(
            "The official SWE-Atlas checkout must be clean before task preparation; "
            f"found: {dirty.splitlines()[0]}"
        )
    return actual


def official_agent_hosts(task_toml: str) -> list[str]:
    parsed = tomllib.loads(task_toml)
    agent = parsed.get("agent")
    if not isinstance(agent, dict) or agent.get("network_mode") != "allowlist":
        return []
    hosts = agent.get("allowed_hosts", [])
    if not isinstance(hosts, list) or not all(isinstance(host, str) for host in hosts):
        raise ValueError("[agent].allowed_hosts must be an array of host strings.")
    return list(dict.fromkeys(host.strip().lower().rstrip(".") for host in hosts))


def _skip_toml_value(lines: list[str], index: int) -> int:
    """Skip a scalar or bracketed TOML value starting at index."""

    line = lines[index]
    if "[" not in line.split("=", 1)[1]:
        return index + 1
    balance = line.count("[") - line.count("]")
    index += 1
    while balance > 0 and index < len(lines):
        balance += lines[index].count("[") - lines[index].count("]")
        index += 1
    if balance != 0:
        raise ValueError("Unterminated allowed_hosts array in task.toml.")
    return index


def enforce_agent_allowlist(task_toml: str) -> tuple[str, list[str]]:
    original_hosts = official_agent_hosts(task_toml)
    merged_hosts = list(dict.fromkeys([*original_hosts, KRATER_API_HOST]))

    lines = task_toml.splitlines(keepends=True)
    agent_start: int | None = None
    agent_end = len(lines)
    for index, line in enumerate(lines):
        if line.strip() == "[agent]":
            agent_start = index
            continue
        if agent_start is not None and index > agent_start and _SECTION.match(line):
            agent_end = index
            break
    if agent_start is None:
        raise ValueError("task.toml has no [agent] section.")

    kept: list[str] = []
    index = agent_start + 1
    while index < agent_end:
        match = _KEY.match(lines[index])
        if not match:
            kept.append(lines[index])
            index += 1
            continue
        index = _skip_toml_value(lines, index)

    policy = [
        'network_mode = "allowlist"\n',
        "allowed_hosts = [\n",
        *(f'  "{host}",\n' for host in merged_hosts),
        "]\n",
    ]
    rewritten = "".join(
        [
            *lines[: agent_start + 1],
            *policy,
            *kept,
            *lines[agent_end:],
        ]
    )
    parsed = tomllib.loads(rewritten)
    agent = parsed["agent"]
    if agent["network_mode"] != "allowlist" or agent["allowed_hosts"] != merged_hosts:
        raise AssertionError("Rewritten task network policy failed validation.")
    return rewritten, merged_hosts


def _safe_remove_task(path: Path, output_root: Path) -> None:
    resolved = path.resolve()
    root = output_root.resolve()
    if resolved.parent != root or not resolved.name.startswith("task-"):
        raise ValueError(f"Refusing to remove unsafe task path: {resolved}")
    shutil.rmtree(resolved)


def clean_prepared_tasks(output_root: Path) -> int:
    """Remove only task-* directories directly under the chosen output root."""

    output_root = output_root.expanduser().resolve()
    if not output_root.exists():
        return 0
    removed = 0
    for path in output_root.iterdir():
        if path.is_dir() and path.name.startswith("task-"):
            _safe_remove_task(path, output_root)
            removed += 1
    return removed


def validate_task_tree(source: Path) -> None:
    """Reject symlinks that escape the pinned official task directory."""

    physical_source = source.resolve(strict=True)
    for path in source.rglob("*"):
        if not path.is_symlink():
            continue
        try:
            target = path.resolve(strict=True)
        except FileNotFoundError as error:
            raise ValueError(f"Task contains a broken symlink: {path}") from error
        if not target.is_relative_to(physical_source):
            raise ValueError(f"Task symlink escapes its directory: {path} -> {target}")


def prepare_task(
    source_root: Path,
    output_root: Path,
    kind: str,
    task_id: str,
    *,
    overwrite: bool = False,
    verify_commit: bool = True,
) -> tuple[Path, list[str]]:
    task_kind = validate_task_kind(kind)
    source_root = source_root.expanduser().resolve(strict=True)
    if verify_commit:
        validate_upstream_checkout(source_root)

    source = source_root / "data" / task_kind / task_id
    if not source.is_dir() or source.name != task_id or not task_id.startswith("task-"):
        raise ValueError(f"Official SWE-Atlas task not found: {source}")
    for required in ("task.toml", "instruction.md", "environment"):
        if not (source / required).exists():
            raise ValueError(f"Task is missing required path: {source / required}")
    validate_task_tree(source)

    output_root = output_root.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    destination = output_root / task_id
    physical_source = source.resolve()
    physical_destination = destination.resolve()
    if (
        physical_destination == physical_source
        or physical_destination.is_relative_to(physical_source)
        or physical_source.is_relative_to(physical_destination)
    ):
        raise ValueError(
            "Prepared-task output and source task must not contain one another."
        )
    if destination.exists():
        if not overwrite:
            raise FileExistsError(
                f"Prepared task already exists: {destination}; pass --overwrite."
            )
        _safe_remove_task(destination, output_root)

    shutil.copytree(source, destination, symlinks=True)
    task_path = destination / "task.toml"
    rewritten, hosts = enforce_agent_allowlist(task_path.read_text())
    task_path.write_text(rewritten)
    return destination, hosts


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare one network-restricted SWE-Atlas task for Krater Pro."
    )
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--kind", required=True, choices=("qa", "tw", "rf"))
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--task-id")
    selection.add_argument(
        "--all",
        action="store_true",
        help="Prepare every official task in the selected category.",
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--clean-output",
        action="store_true",
        help="First remove only task-* directories directly under --output-root.",
    )
    parser.add_argument(
        "--skip-commit-check",
        action="store_true",
        help="Testing only: do not verify the official upstream commit.",
    )
    args = parser.parse_args()
    source_root = args.source_root.expanduser().resolve(strict=True)
    if not args.skip_commit_check:
        validate_upstream_checkout(source_root)
    if args.all:
        task_ids = sorted(
            path.name
            for path in (source_root / "data" / args.kind).iterdir()
            if path.is_dir() and path.name.startswith("task-")
        )
        if not task_ids:
            raise ValueError(f"No {args.kind} tasks found under {source_root}.")
    else:
        task_ids = [args.task_id or SMOKE_TASKS[args.kind]]

    if args.clean_output:
        clean_prepared_tasks(args.output_root)

    prepared = []
    for task_id in task_ids:
        destination, hosts = prepare_task(
            source_root,
            args.output_root,
            args.kind,
            task_id,
            overwrite=args.overwrite,
            verify_commit=False,
        )
        prepared.append(
            {
                "task": str(destination),
                "task_id": task_id,
                "agent_allowed_hosts": hosts,
            }
        )
    print(
        json.dumps(
            {
                "kind": args.kind,
                "count": len(prepared),
                "upstream_commit": (
                    None if args.skip_commit_check else EXPECTED_UPSTREAM_COMMIT
                ),
                "prepared": prepared,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

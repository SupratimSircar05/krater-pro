"""Pure-stdlib contracts shared by the SWE-Atlas Harbor agent and its tests."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlparse

TaskKind = Literal["qa", "tw", "rf"]

EXACT_MODEL = "moonshotai/kimi-k3"
EXACT_BASE_URL = "https://api.krater.ai/v1"
KRATER_API_HOST = "api.krater.ai"
SUPPORTED_KINDS: tuple[TaskKind, ...] = ("qa", "tw", "rf")
MAX_BUNDLE_BYTES = 64 * 1024 * 1024
MAX_SKILLS_FILES = 2_048
MAX_SKILLS_BYTES = 32 * 1024 * 1024
NODE_VERSION_GATE_JS = (
    "const [major,minor]=process.versions.node.split('.').map(Number);"
    "const ok=(major===20&&minor>=19)||(major===22&&minor>=12)||major>22;"
    "if(!ok)process.exit(1)"
)

_ANSI_ESCAPE = re.compile(
    r"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~])"
)
_USAGE = re.compile(
    r"tokens:\s*(?P<request>\d+)"
    r"(?:\s*[·|]\s*session\s+(?P<session>\d+))?"
    r"(?:\s*[·|]\s*cached request\s+(?P<cached_request>\d+))?"
    r"(?:\s*[·|]\s*cached session\s+(?P<cached_session>\d+))?"
)
_NODE_VERSION = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)(?:\.\d+)?")
_PAYLOAD_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")


def validate_task_kind(value: str) -> TaskKind:
    normalized = value.strip().lower()
    if normalized not in SUPPORTED_KINDS:
        supported = ", ".join(SUPPORTED_KINDS)
        raise ValueError(f"Unsupported SWE-Atlas task kind {value!r}; use {supported}.")
    return cast(TaskKind, normalized)


def validate_model(value: str | None) -> str:
    if value != EXACT_MODEL:
        raise ValueError(
            "SWE-Atlas evaluation is pinned to "
            f"{EXACT_MODEL!r}; received {value!r}."
        )
    return value


def validate_base_url(value: str | None) -> str:
    if value != EXACT_BASE_URL:
        raise ValueError(
            "SWE-Atlas evaluation is pinned to "
            f"{EXACT_BASE_URL!r}; received {value!r}."
        )
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != KRATER_API_HOST:
        raise ValueError("Krater benchmark traffic must use api.krater.ai over HTTPS.")
    return value


def node_version_supported(value: str) -> bool:
    """Match the product's declared ^20.19.0 || >=22.12.0 engine range."""

    match = _NODE_VERSION.match(value.strip())
    if not match:
        return False
    major = int(match.group("major"))
    minor = int(match.group("minor"))
    return (
        (major == 20 and minor >= 19)
        or (major == 22 and minor >= 12)
        or major > 22
    )


def resolve_bundle_path(value: str | None) -> Path:
    if not value:
        raise ValueError(
            "KRATER_PRO_BUNDLE is required. Run "
            "benchmarks/swe_atlas/build_bundle.sh first."
        )
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError(f"KRATER_PRO_BUNDLE is not a regular file: {path}")
    if path.suffix not in {".js", ".mjs"}:
        raise ValueError("KRATER_PRO_BUNDLE must be a .js or .mjs file.")
    size = path.stat().st_size
    if size <= 0 or size > MAX_BUNDLE_BYTES:
        raise ValueError(
            f"KRATER_PRO_BUNDLE must be between 1 byte and {MAX_BUNDLE_BYTES} bytes."
        )
    return path


def resolve_skills_path(value: str | None, default: Path) -> Path:
    path = Path(value).expanduser() if value else default
    path = path.resolve(strict=True)
    marker = path / "programming-languages" / "SKILL.md"
    if not path.is_dir() or not marker.is_file():
        raise ValueError(
            "Krater Pro skills directory must contain "
            "programming-languages/SKILL.md."
        )
    return path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_skills_manifest(root: Path) -> tuple[list[dict[str, str | int]], str]:
    """Create a deterministic, symlink-free manifest for the uploaded skill tree."""

    root = root.resolve(strict=True)
    records: list[dict[str, str | int]] = []
    total_bytes = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if not _PAYLOAD_PATH.fullmatch(relative):
            raise ValueError(f"Unsafe skill payload path: {relative!r}")
        if path.is_symlink():
            raise ValueError(f"Skill payload must not contain symlinks: {relative}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"Skill payload contains a non-regular file: {relative}")
        size = path.stat().st_size
        total_bytes += size
        records.append(
            {
                "path": relative,
                "size": size,
                "sha256": _sha256_file(path),
            }
        )
        if len(records) > MAX_SKILLS_FILES or total_bytes > MAX_SKILLS_BYTES:
            raise ValueError(
                "Krater Pro skills payload exceeds the benchmark file or byte limit"
            )
    if not records:
        raise ValueError("Krater Pro skills payload is empty")

    canonical = "".join(
        f"{record['sha256']}\0{record['size']}\0{record['path']}\n"
        for record in records
    ).encode("utf-8")
    return records, hashlib.sha256(canonical).hexdigest()


def build_payload_manifest(bundle: Path, skills_root: Path) -> dict[str, object]:
    records, skills_digest = build_skills_manifest(skills_root)
    return {
        "schema": 1,
        "bundle": {
            "path": "dist/krater-pro.mjs",
            "size": bundle.stat().st_size,
            "sha256": _sha256_file(bundle),
        },
        "skills": {
            "root": "skills",
            "files": records,
            "sha256": skills_digest,
        },
    }


def serialize_payload_manifest(manifest: dict[str, object]) -> str:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"


def submission_addendum(kind: TaskKind) -> str:
    common = """

Krater Pro benchmark requirements:
- Work only in the repository selected as your workspace.
- Do not use web search, web fetch, or network tools. The only external request
  permitted is Krater Pro's model call to api.krater.ai.
- Inspect the repository and run relevant local checks before finishing.
""".rstrip()

    if kind == "qa":
        contract = """
- Do not edit, commit, add, or remove repository files. The harness requires
  the same HEAD and no Git-visible tracked or untracked changes at submission.
- Before finishing, use the shell tool to write the complete answer to
  /logs/agent/answer.txt. Wrap it in one opening and one closing
  <<FINAL_ANSWER>> line. Do not put placeholder text in that file.
""".rstrip()
    elif kind == "tw":
        contract = """
- Add the requested tests to the repository and run the most relevant checks.
- Before finishing, use the shell tool to write /logs/agent/manifest.txt.
  Wrap a YAML-like list of every test file and test name in one opening and one
  closing <<TEST_MANIFEST>> line.
- Do not edit existing tests unless the task explicitly requires it.
""".rstrip()
    else:
        contract = """
- Make only the requested minimal non-test source changes.
- Do not modify test files or testing logic.
- Run relevant checks and leave the working-tree changes in place for grading.
""".rstrip()

    return f"{common}\n{contract}\n"


def parse_usage_log(text: str) -> dict[str, int]:
    """Extract cumulative total/cache telemetry from Krater Pro's terminal log."""

    clean = _ANSI_ESCAPE.sub("", text)
    request_total = 0
    session_totals: list[int] = []
    cached_request_total = 0
    cached_session_totals: list[int] = []

    for match in _USAGE.finditer(clean):
        request_total += int(match.group("request"))
        if match.group("session"):
            session_totals.append(int(match.group("session")))
        if match.group("cached_request"):
            cached_request_total += int(match.group("cached_request"))
        if match.group("cached_session"):
            cached_session_totals.append(int(match.group("cached_session")))

    return {
        "total_tokens": max(session_totals, default=request_total),
        "cached_tokens": max(cached_session_totals, default=cached_request_total),
    }


def workspace_discovery_shell() -> str:
    """Return a fixed shell fragment that finds the task repository."""

    return r"""
workspace=""
for candidate in \
  /app /workspace /code /repo /src /grafana /testbed \
  /opt/netdata.git /go/src/go.k6.io/k6 /home/circleci/wp-calypso \
  /app/source /app/suricata /src/suricata
do
  if [ -d "$candidate/.git" ]; then
    workspace="$(git -C "$candidate" rev-parse --show-toplevel)"
    break
  fi
done
if [ -z "$workspace" ]; then
  git_dir="$(find / -maxdepth 5 -type d -name .git -print -quit 2>/dev/null || true)"
  if [ -n "$git_dir" ]; then
    workspace="$(git -C "${git_dir%/.git}" rev-parse --show-toplevel)"
  fi
fi
if [ -z "$workspace" ] || [ ! -d "$workspace/.git" ]; then
  echo "Krater Pro could not locate the SWE-Atlas repository." >&2
  exit 66
fi
if [ -n "$(git -C "$workspace" -c core.fsmonitor=false \
  status --porcelain=v1 --untracked-files=all)" ]; then
  echo "SWE-Atlas repository was dirty before agent execution." >&2
  exit 65
fi
printf '%s\n' "$workspace"
git -C "$workspace" rev-parse HEAD
""".strip()

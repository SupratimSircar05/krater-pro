# Python

## Ecosystem detection

- Confirm `.py`/`.pyi`, a Python shebang, imports, notebooks, or extension modules.
- Treat `pyproject.toml` as primary evidence; `uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements*.txt`, `setup.cfg`, `tox.ini`, and `.python-version` identify the environment and tools.
- Distinguish CPython, PyPy, MicroPython, and embedded Python before relying on implementation details.

## Canonical toolchains

- Use the pinned interpreter through `uv`, Poetry, Pipenv, Conda, `venv`, or the repository wrapper; do not mix environment managers.
- Packaging commonly uses `uv build`, `python -m build`, Poetry, Hatch, PDM, or setuptools. Testing commonly uses pytest or `unittest`.
- Select Ruff/Black/isort, mypy/Pyright, and coverage only when configured; configuration overrides global defaults.

## Inspect-first files

- Read `pyproject.toml`, lock/requirements files, `.python-version`, `tox.ini`, `noxfile.py`, `conftest.py`, package entry points, and CI.
- Check `src/` layout, namespace packages, generated modules, migration directories, and type-checker path settings.

## Build, test, lint, and format

- Install exactly from the lock with the owning manager, such as `uv sync --frozen`, `poetry install`, or `python -m pip install -r requirements.txt`; do not invent one if unpinned.
- Use configured commands: `python -m pytest`, `python -m unittest`, `tox`, or `nox`; narrow pytest with `path::test_name`.
- Typical configured checks are `ruff check .`, `ruff format --check .`, `black --check .`, `mypy <package>`, `pyright`, and `python -m build`.
- Invoke tools as modules when interpreter alignment matters. Avoid updating a lock merely to run tests.

## Implementation idioms

- Preserve public annotations, dataclass/Pydantic model semantics, context managers, iterator behavior, and sync-versus-async APIs.
- Use explicit exception types and exception chaining; avoid mutable default arguments, broad `except`, import-time side effects, and hidden global state.
- Respect package boundaries and dependency injection already present; keep I/O at edges and pure transformations testable.

## Debugging workflow

- Reproduce under the pinned interpreter with `python -X dev`, focused pytest, `breakpoint()`/`pdb`, or configured IDE debugging.
- Inspect complete tracebacks and exception causes. Use `pytest -vv -s`, `--log-cli-level`, `faulthandler`, or `tracemalloc` only as needed.
- Diagnose import errors with `python -c 'import sys; print(sys.executable); print(sys.path)'` without printing sensitive environment values.

## Concurrency, memory, and performance

- Distinguish threads, processes, `asyncio`, and alternative runtimes. Do not block an event loop with synchronous I/O or CPU work.
- Protect shared mutable state; understand cancellation, task ownership, process serialization, and the GIL rather than assuming thread safety.
- Profile before optimizing with `cProfile`, `py-spy`, `scalene`, `tracemalloc`, or benchmarks. Watch generator materialization, N+1 I/O, copies, and unbounded caches.

## Security hazards

- Avoid `eval`/`exec`, unsafe pickle/yaml loading, shell interpolation, unparameterized SQL, unsafe archive extraction, and path traversal.
- Pin dependencies and inspect install hooks. Never log environment contents, credentials, tokens, or untrusted request bodies.
- Use `subprocess` argument arrays and explicit timeouts; use `shell=True` only with a justified, trusted command.

## Interoperability

- Validate JSON/timezone/decimal/Unicode conventions at API boundaries.
- For C/Rust extensions, match Python ABI, architecture, reference ownership, GIL rules, and wheel platform tags.
- For notebooks or model artifacts, separate reproducible source/configuration from large generated outputs.

## Common failure modes

- Wrong interpreter or stale virtual environment; package shadowing by a local filename; editable-install drift; missing extras; sync call inside async code.
- Tests pass from one working directory only; timezone/locale assumptions; fixture leakage; `None` or numeric truthiness mistakes; version-dependent typing syntax.

## Verification checklist

- [ ] Confirm interpreter and environment manager match pins.
- [ ] Reproduce and cover the failure with a focused test.
- [ ] Run configured format, lint, type, and package-build checks.
- [ ] Run relevant integration tests and import/CLI smoke tests.
- [ ] Check async cancellation, resource cleanup, and sensitive output where applicable.

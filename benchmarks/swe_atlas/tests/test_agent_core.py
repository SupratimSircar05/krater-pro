from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from benchmarks.swe_atlas.agent_core import (
    EXACT_BASE_URL,
    EXACT_MODEL,
    MAX_BUNDLE_BYTES,
    build_payload_manifest,
    build_skills_manifest,
    node_version_supported,
    parse_usage_log,
    resolve_bundle_path,
    resolve_skills_path,
    submission_addendum,
    validate_base_url,
    validate_model,
    validate_task_kind,
    workspace_discovery_shell,
)


class AgentCoreTests(unittest.TestCase):
    def test_exact_model_and_endpoint_are_enforced(self) -> None:
        self.assertEqual(validate_model(EXACT_MODEL), EXACT_MODEL)
        self.assertEqual(validate_base_url(EXACT_BASE_URL), EXACT_BASE_URL)
        with self.assertRaisesRegex(ValueError, "pinned"):
            validate_model("moonshotai/kimi-k2")
        with self.assertRaisesRegex(ValueError, "pinned"):
            validate_base_url("https://example.test/v1")

    def test_node_gate_matches_package_engine_range(self) -> None:
        self.assertTrue(node_version_supported("20.19.0"))
        self.assertTrue(node_version_supported("22.12.0"))
        self.assertTrue(node_version_supported("25.8.0"))
        self.assertFalse(node_version_supported("20.18.9"))
        self.assertFalse(node_version_supported("21.7.3"))
        self.assertFalse(node_version_supported("22.11.0"))
        self.assertFalse(node_version_supported("not-a-version"))

    def test_task_kinds_are_closed_set(self) -> None:
        self.assertEqual(validate_task_kind(" QA "), "qa")
        self.assertEqual(validate_task_kind("tw"), "tw")
        self.assertEqual(validate_task_kind("rf"), "rf")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            validate_task_kind("issue-resolution")

    def test_submission_contracts_match_official_outputs(self) -> None:
        qa = submission_addendum("qa")
        tw = submission_addendum("tw")
        rf = submission_addendum("rf")
        self.assertIn("/logs/agent/answer.txt", qa)
        self.assertIn("<<FINAL_ANSWER>>", qa)
        self.assertIn("/logs/agent/manifest.txt", tw)
        self.assertIn("<<TEST_MANIFEST>>", tw)
        self.assertIn("Do not modify test files", rf)
        for prompt in (qa, tw, rf):
            self.assertIn("api.krater.ai", prompt)
            self.assertIn("Do not use web search", prompt)

    def test_usage_parser_prefers_cumulative_session_values(self) -> None:
        text = (
            "\x1b[2mtokens: 10 · cached request 2\x1b[0m\n"
            "tokens: 14 · session 24 · cached request 3 · cached session 5\n"
        )
        self.assertEqual(
            parse_usage_log(text),
            {"total_tokens": 24, "cached_tokens": 5},
        )

    def test_usage_parser_sums_requests_when_session_is_absent(self) -> None:
        self.assertEqual(
            parse_usage_log("tokens: 7\ntokens: 11 · cached request 4\n"),
            {"total_tokens": 18, "cached_tokens": 4},
        )

    def test_bundle_validation_is_local_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "krater-pro.mjs"
            bundle.write_text("console.log('ok')")
            self.assertEqual(resolve_bundle_path(str(bundle)), bundle.resolve())

            bad_suffix = root / "bundle.txt"
            bad_suffix.write_text("x")
            with self.assertRaisesRegex(ValueError, r"\.js"):
                resolve_bundle_path(str(bad_suffix))

            empty = root / "empty.js"
            empty.touch()
            with self.assertRaisesRegex(ValueError, str(MAX_BUNDLE_BYTES)):
                resolve_bundle_path(str(empty))

    def test_skills_payload_requires_programming_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "programming-languages"):
                resolve_skills_path(None, root)
            skill = root / "programming-languages"
            skill.mkdir()
            (skill / "SKILL.md").write_text("---\nname: programming-languages\n---\n")
            self.assertEqual(resolve_skills_path(None, root), root.resolve())

    def test_skills_manifest_is_deterministic_and_content_sensitive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = root / "programming-languages"
            references = skill / "references"
            references.mkdir(parents=True)
            (skill / "SKILL.md").write_text("guide\n")
            reference = references / "typescript.md"
            reference.write_text("first\n")
            bundle = root / "krater-pro.mjs"
            bundle.write_text("bundle\n")

            records, digest = build_skills_manifest(root)
            manifest = build_payload_manifest(bundle, root)
            self.assertEqual(records, build_skills_manifest(root)[0])
            self.assertEqual(digest, manifest["skills"]["sha256"])
            reference.write_text("second\n")
            self.assertNotEqual(digest, build_skills_manifest(root)[1])

    def test_skills_manifest_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = root / "programming-languages"
            skill.mkdir()
            (skill / "SKILL.md").write_text("guide\n")
            (skill / "escape.md").symlink_to(Path(temporary) / "outside.md")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                build_skills_manifest(root)

    def test_node_payload_verifier_enforces_bundle_and_skills_digests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installed = root / "installed-agent"
            (installed / "dist").mkdir(parents=True)
            skills = installed / "skills" / "programming-languages"
            skills.mkdir(parents=True)
            references = skills / "references"
            references.mkdir()
            bundle = installed / "dist/krater-pro.mjs"
            bundle.write_text("bundle\n")
            skill = skills / "SKILL.md"
            skill.write_text("guide\n")
            (references / "c-sharp.md").write_text("c#\n")
            (references / "cpp.md").write_text("c++\n")
            (references / "objective-c.md").write_text("objc\n")
            manifest = build_payload_manifest(bundle, installed / "skills")
            (installed / "payload-manifest.json").write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            verifier = Path(__file__).resolve().parents[1] / "payload_verify.mjs"

            accepted = subprocess.run(
                ["node", str(verifier), str(installed)],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertIn("payload verified", accepted.stdout)

            skill.write_text("tampered\n")
            rejected = subprocess.run(
                ["node", str(verifier), str(installed)],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("digest or size mismatch", rejected.stderr)

    def test_workspace_discovery_is_fixed_shell_not_prompt_interpolation(self) -> None:
        shell = workspace_discovery_shell()
        self.assertIn("/app", shell)
        self.assertIn("rev-parse --show-toplevel", shell)
        self.assertIn("git -C \"$workspace\" rev-parse HEAD", shell)
        self.assertIn("dirty before agent execution", shell)
        self.assertNotIn("/installed-agent/workspace", shell)
        self.assertNotIn("instruction", shell)


if __name__ == "__main__":
    unittest.main()

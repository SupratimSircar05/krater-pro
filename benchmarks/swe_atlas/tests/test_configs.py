from __future__ import annotations

import unittest
from pathlib import Path

from benchmarks.swe_atlas.agent_core import EXACT_BASE_URL, EXACT_MODEL


class ConfigContractTests(unittest.TestCase):
    def test_all_tracks_use_exact_model_and_no_agent_environment(self) -> None:
        config_root = Path(__file__).resolve().parents[1] / "config"
        for kind in ("qa", "tw", "rf"):
            with self.subTest(kind=kind):
                text = (config_root / f"{kind}.yaml").read_text()
                self.assertIn(f"model_name: {EXACT_MODEL}", text)
                self.assertIn("- api.krater.ai", text)
                self.assertIn(f"task_kind: {kind}", text)
                self.assertNotIn("env:", text)
                self.assertNotIn("KRATER_API_KEY", text)
                self.assertNotIn("KRATER_BASE_URL", text)
                self.assertNotIn("KRATER_MODEL", text)
                self.assertNotRegex(text, r"kr_(?:live|test)_[A-Za-z0-9]")

    def test_generated_payloads_and_results_are_ignored_locally(self) -> None:
        ignore = (Path(__file__).resolve().parents[1] / ".gitignore").read_text()
        self.assertEqual(
            set(ignore.splitlines()),
            {"/.artifacts/", "/.work/", "/results/"},
        )


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env -S pipx run

# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "json5==0.17.3",
#   "typer==0.27.2",
# ]
# ///

"""Unit tests for pi-switch. Run: make test-pi-switch

The pins mirror pi-switch.py's PEP 723 metadata, because importing the tool
module imports those packages.
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any

TOOL_PATH = Path(__file__).resolve().parent / "pi-switch.py"


def load_tool() -> ModuleType:
    """Imports pi-switch.py; its dashed file name needs an explicit file load."""
    spec = importlib.util.spec_from_file_location("pi_switch", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool: Any = load_tool()


class MergeTest(unittest.TestCase):
    def test_merges_objects_and_replaces_arrays(self) -> None:
        source = {"nested": {"kept": True, "overridden": "old"}, "items": [1, 2]}
        target = {"nested": {"overridden": "new", "added": True}, "items": [3]}

        merged = tool.merge_objects(source, target)

        self.assertEqual(
            merged,
            {
                "nested": {"kept": True, "overridden": "new", "added": True},
                "items": [3],
            },
        )

    def test_null_targets_keep_source_objects_and_replace_scalars(self) -> None:
        source = {"nested": {"kept": True}, "replaced": "source"}
        target = {"nested": None, "replaced": None}

        merged = tool.merge_objects(source, target)

        self.assertEqual(merged, {"nested": {"kept": True}, "replaced": None})


class ResolvePresetTest(unittest.TestCase):
    def test_applies_parents_in_order_and_removes_metadata(self) -> None:
        presets = {
            "base": {"common": True, "model": "base/model", "base_only": True},
            "second": {"model": "second/model"},
            "selected": {"extends": ["base", "second"], "model": "selected/model"},
        }
        self.assertEqual(
            tool.resolve_preset(presets, "selected", ()),
            {"model": "selected/model", "base_only": True},
        )

    def test_rejects_inheritance_cycles(self) -> None:
        presets = {"first": {"extends": ["second"]}, "second": {"extends": ["first"]}}
        with self.assertRaises(tool.ConfigError) as raised:
            tool.resolve_preset(presets, "first", ())
        self.assertEqual(
            str(raised.exception),
            "Circular preset inheritance detected: first -> second -> first",
        )


class SplitModelTest(unittest.TestCase):
    def test_splits_on_the_first_slash(self) -> None:
        self.assertEqual(
            tool.split_model("openai/gpt-5.6-sol"), ("openai", "gpt-5.6-sol")
        )
        self.assertEqual(
            tool.split_model("openrouter/vendor/model"), ("openrouter", "vendor/model")
        )
        self.assertEqual(tool.split_model("gpt-5.6-sol"), (None, "gpt-5.6-sol"))
        self.assertEqual(tool.split_model("/gpt-5.6-sol"), (None, "/gpt-5.6-sol"))
        self.assertEqual(tool.split_model("openai/"), (None, "openai/"))


class ToSettingsTest(unittest.TestCase):
    def test_maps_model_and_thinking_level(self) -> None:
        merged = {
            "defaultTools": ["read"],
            "model": "openai/gpt-5.6-sol",
            "thinkingLevel": "high",
            "agent": {"Solo": {"model": "openai/gpt-5.6-sol"}},
        }

        settings = tool.to_settings(merged)

        self.assertEqual(
            settings,
            {
                "defaultTools": ["read"],
                "defaultProvider": "openai",
                "defaultModel": "gpt-5.6-sol",
                "defaultThinkingLevel": "high",
            },
        )

    def test_keeps_model_without_provider_and_drops_non_string_levels(self) -> None:
        merged = {"model": "gpt-5.6-sol", "thinkingLevel": 3, "agent": {}}

        settings = tool.to_settings(merged)

        self.assertEqual(settings, {"defaultModel": "gpt-5.6-sol"})


class ToAgentModelsTest(unittest.TestCase):
    def test_keeps_object_entries_and_string_fields(self) -> None:
        merged = {
            "agent": {
                "Solo": {
                    "model": "openai/gpt-5.6-sol",
                    "thinkingLevel": "high",
                    "disabled": True,
                },
                "Analyst": {
                    "model": "openai/gpt-5.6-sol",
                    "thinkingLevel": "high",
                },
                "Junior": {"model": 7},
                "Explorer": "not-an-object",
                "Librarian": {},
            }
        }

        agent_models = tool.to_agent_models(merged)

        self.assertEqual(
            agent_models,
            {
                "Solo": {"model": "openai/gpt-5.6-sol", "thinkingLevel": "high"},
                "Analyst": {"model": "openai/gpt-5.6-sol", "thinkingLevel": "high"},
                "Junior": {},
                "Librarian": {},
            },
        )

    def test_ignores_missing_or_non_object_agents(self) -> None:
        self.assertEqual(tool.to_agent_models({}), {})
        self.assertEqual(tool.to_agent_models({"agent": ["Solo"]}), {})


class MergeExistingSettingsTest(unittest.TestCase):
    def test_generated_settings_win_and_local_keys_survive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "settings.json").write_text(
                '{"lastChangelogVersion": "1.1.0", "defaultModel": "old"}',
                encoding="utf-8",
            )
            original = tool.CONFIG_DIR
            tool.CONFIG_DIR = Path(tmp)
            try:
                merged = tool.merge_existing_settings({"defaultModel": "new"})
            finally:
                tool.CONFIG_DIR = original
        self.assertEqual(
            merged,
            {"lastChangelogVersion": "1.1.0", "defaultModel": "new"},
        )

    def test_missing_or_malformed_existing_settings_are_ignored(self) -> None:
        for content in (None, "not json", "[1]"):
            with tempfile.TemporaryDirectory() as tmp:
                if content is not None:
                    (Path(tmp) / "settings.json").write_text(content, encoding="utf-8")
                original = tool.CONFIG_DIR
                tool.CONFIG_DIR = Path(tmp)
                try:
                    merged = tool.merge_existing_settings({"defaultModel": "new"})
                finally:
                    tool.CONFIG_DIR = original
            self.assertEqual(merged, {"defaultModel": "new"})


class ReadJsoncTest(unittest.TestCase):
    def test_reads_comments_and_trailing_commas(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.jsonc"
            path.write_text('{\n  // fragment\n  "enabled": true,\n}', encoding="utf-8")
            self.assertEqual(tool.read_jsonc_object(path), {"enabled": True})

    def test_rejects_non_object_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.jsonc"
            path.write_text("[1]", encoding="utf-8")
            with self.assertRaises(tool.ConfigError):
                tool.read_jsonc_object(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)

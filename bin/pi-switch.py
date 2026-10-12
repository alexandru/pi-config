#!/usr/bin/env -S pipx run

# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "json5==0.17.3",
#   "typer==0.27.2",
# ]
# ///

"""Generate Pi's configuration from a preset.

Merges pi.common.jsonc with a preset from pi.presets.jsonc and writes
settings.json and agents.models.json. Presets inherit from other presets via
"extends"; fragments marked "common": true stay hidden from direct selection.
"""

import json
import sys
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, TypeAlias

import json5
import typer

COMMON_FILE = "pi.common.jsonc"
PRESETS_FILE = "pi.presets.jsonc"
SETTINGS_FILE = "settings.json"
AGENT_MODELS_FILE = "agents.models.json"

CONFIG_DIR = Path(__file__).resolve().parent.parent

Json: TypeAlias = dict[str, "Json"] | list["Json"] | str | int | float | bool | None
JsonObject: TypeAlias = dict[str, Json]


class ConfigError(Exception):
    """A configuration problem, reported as one clear message, not a traceback."""


def merge_objects(source: JsonObject, target: JsonObject) -> JsonObject:
    """Target values win, shared objects merge recursively, a target null keeps
    the source object, and the result keeps the source's key order, then keys
    new in the target.
    """
    merged = dict(source)
    for key, target_value in target.items():
        source_value = merged.get(key)
        if isinstance(source_value, dict) and target_value is None:
            merged[key] = source_value
        elif isinstance(source_value, dict) and isinstance(target_value, dict):
            merged[key] = merge_objects(source_value, target_value)
        else:
            merged[key] = target_value
    return merged


def extends_names(preset: JsonObject, name: str) -> list[str]:
    extends = preset.get("extends")
    if extends is None:
        return []
    invalid = (
        f"Preset '{name}' has invalid 'extends'; expected an array of preset names."
    )
    if not isinstance(extends, list):
        raise ConfigError(invalid)
    names: list[str] = []
    for item in extends:
        if not isinstance(item, str):
            raise ConfigError(invalid)
        names.append(item)
    return names


def strip_preset_metadata(preset: JsonObject) -> JsonObject:
    """The preset as Pi configuration, without the switcher's own keys."""
    return {
        key: value for key, value in preset.items() if key not in ("common", "extends")
    }


def resolve_preset(
    presets: JsonObject, name: str, ancestors: tuple[str, ...]
) -> JsonObject:
    """The preset with every "extends" parent merged in.

    Later parents override earlier ones, and the preset overrides its parents.
    `ancestors` is the resolution path, so inheritance cycles can be reported.
    """
    preset = presets.get(name)
    if preset is None:
        raise ConfigError(f"Preset '{name}' not found in {PRESETS_FILE}")
    if not isinstance(preset, dict):
        raise ConfigError(f"Preset '{name}' must be an object")
    if name in ancestors:
        cycle = ancestors[ancestors.index(name) :] + (name,)
        raise ConfigError("Circular preset inheritance detected: " + " -> ".join(cycle))

    inherited: JsonObject = {}
    for parent in extends_names(preset, name):
        inherited = merge_objects(
            inherited, resolve_preset(presets, parent, (*ancestors, name))
        )
    return merge_objects(inherited, strip_preset_metadata(preset))


def read_jsonc_object(path: Path) -> JsonObject:
    """The root object of a JSONC file; configuration files must be objects."""
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ConfigError(f"configuration file missing: {path}") from None
    except OSError as error:
        raise ConfigError(f"failed to read {path}: {error}") from None
    try:
        value = json5.loads(content)
    except ValueError as error:
        raise ConfigError(f"failed to parse {path}: {error}") from None
    if not isinstance(value, dict):
        raise ConfigError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: Json) -> None:
    """Pretty-printed JSON with a trailing newline."""
    content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    try:
        path.write_text(content, encoding="utf-8")
    except OSError as error:
        raise ConfigError(f"failed to write {path}: {error}") from None


def split_model(model: str) -> tuple[str | None, str]:
    """Splits `provider/model` on the first slash; a leading or trailing slash
    leaves no provider and the whole reference becomes the model.
    """
    slash = model.find("/")
    if 0 < slash < len(model) - 1:
        return model[:slash], model[slash + 1 :]
    return None, model


def to_settings(merged: JsonObject) -> JsonObject:
    """The settings.json contents: the `agent` map moves to agents.models.json,
    and `model` and `thinkingLevel` become Pi's default* settings.
    """
    settings = {key: value for key, value in merged.items() if key != "agent"}
    model = settings.get("model")
    if isinstance(model, str):
        provider, default_model = split_model(model)
        if provider is not None:
            settings["defaultProvider"] = provider
        settings["defaultModel"] = default_model
    settings.pop("model", None)

    level = settings.get("thinkingLevel")
    if isinstance(level, str):
        settings["defaultThinkingLevel"] = level
    settings.pop("thinkingLevel", None)
    return settings


def merge_existing_settings(settings: JsonObject) -> JsonObject:
    """The generated settings merged over the existing file, so hand-made local
    settings survive; missing, unreadable, malformed, and non-object existing
    settings are ignored.
    """
    try:
        existing = json5.loads((CONFIG_DIR / SETTINGS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return settings
    if not isinstance(existing, dict):
        return settings
    return merge_objects(existing, settings)


def to_agent_models(merged: JsonObject) -> JsonObject:
    """Per-agent entries for the bundled subagent extension: only object-shaped
    agents, and only string `model` and `thinkingLevel` fields.
    """
    agents = merged.get("agent")
    if not isinstance(agents, dict):
        return {}
    models: JsonObject = {}
    for name, config in agents.items():
        if not isinstance(config, dict):
            continue
        entry: JsonObject = {}
        model = config.get("model")
        if isinstance(model, str):
            entry["model"] = model
        level = config.get("thinkingLevel")
        if isinstance(level, str):
            entry["thinkingLevel"] = level
        models[name] = entry
    return models


def visible_preset_names(presets: JsonObject) -> Iterator[str]:
    """Presets selectable on the command line; "common": true fragments only get inherited."""
    for name, preset in presets.items():
        if not (isinstance(preset, dict) and preset.get("common") is True):
            yield name


def format_presets(presets: JsonObject) -> str:
    return "\n".join(f"  - {name}" for name in visible_preset_names(presets))


def print_help(presets: JsonObject) -> None:
    print("Pi Configuration Preset Switcher\n")
    print("Usage: pi-switch <preset-name>\n")
    print(f"Available presets:\n{format_presets(presets)}\n")
    print("Description:")
    print(f"  Merges {COMMON_FILE} with the selected preset")
    print(f"  from {PRESETS_FILE} to generate {SETTINGS_FILE} and")
    print(f"  {AGENT_MODELS_FILE}")


def string_field(config: Json, key: str, default: str) -> str:
    value = config.get(key) if isinstance(config, dict) else None
    return value if isinstance(value, str) else default


@dataclass(frozen=True)
class AgentRow:
    name: str
    model: str
    thinking_level: str


def column_width(header: str, values: Iterable[str]) -> int:
    return max([len(header), *(len(value) for value in values)])


def print_agent_table(agent_models: JsonObject) -> None:
    if not agent_models:
        return
    rows = [
        AgentRow(
            name=name,
            model=string_field(config, "model", "-"),
            thinking_level=string_field(config, "thinkingLevel", "-"),
        )
        for name, config in agent_models.items()
    ]
    name_width = column_width("Agent", (row.name for row in rows))
    model_width = column_width("Model", (row.model for row in rows))
    level_width = column_width("Thinking", (row.thinking_level for row in rows))

    print()
    print(f"  {'Agent':<{name_width}} │ {'Model':<{model_width}} │ Thinking")
    print(f"  {'─' * name_width}─┼─{'─' * model_width}─┼─{'─' * level_width}")
    for row in rows:
        print(
            f"  {row.name:<{name_width}} │ {row.model:<{model_width}} │ {row.thinking_level}"
        )
    print()


def switch(preset: str | None) -> None:
    """Generates Pi's configuration from the selected preset, or prints help."""
    presets = read_jsonc_object(CONFIG_DIR / PRESETS_FILE)
    if preset is None:
        print_help(presets)
        return
    if preset not in presets:
        raise ConfigError(
            f"Preset '{preset}' not found in {PRESETS_FILE}\n\n"
            f"Available presets:\n{format_presets(presets)}\n\n"
            "Usage: pi-switch <preset-name>"
        )
    common = read_jsonc_object(CONFIG_DIR / COMMON_FILE)
    merged = merge_objects(common, resolve_preset(presets, preset, ()))

    # Both outputs are derived before either is written, so neither file is
    # written without the other.
    settings = merge_existing_settings(to_settings(merged))
    agent_models = to_agent_models(merged)

    write_json(CONFIG_DIR / SETTINGS_FILE, settings)
    write_json(CONFIG_DIR / AGENT_MODELS_FILE, agent_models)

    print(f"✓ Successfully switched to preset: {preset}")
    print(f"✓ Generated {SETTINGS_FILE}")
    print(f"✓ Generated {AGENT_MODELS_FILE}")
    print_agent_table(agent_models)


app = typer.Typer(add_completion=False, context_settings={"help_option_names": []})


@app.command()
def main(
    preset: Annotated[
        str | None, typer.Argument(metavar="PRESET", help="Preset to apply")
    ] = None,
    show_help: Annotated[bool, typer.Option("--help", "-h", help="Print help")] = False,
) -> None:
    """Generate a Pi configuration from a preset."""
    try:
        switch(None if show_help else preset)
    except ConfigError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise typer.Exit(code=1) from None


if __name__ == "__main__":
    app()

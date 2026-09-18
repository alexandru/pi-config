#!/usr/bin/env -S cargo +nightly -q -Zscript
---cargo
[package]
edition = "2024"

[dependencies]
anyhow = "1"
clap = { version = "4", features = ["derive"] }
jsonc-parser = { version = "0.33", features = ["serde"] }
serde_json = { version = "1", features = ["preserve_order"] }
---

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use jsonc_parser::{ParseOptions, parse_to_serde_value};
use serde_json::{Map, Value};

const COMMON_FILE: &str = "pi.common.jsonc";
const PRESETS_FILE: &str = "pi.presets.jsonc";
const SETTINGS_FILE: &str = "settings.json";
const AGENT_MODELS_FILE: &str = "agents.models.json";

#[derive(Debug, Parser)]
#[command(
    name = "pi-switch",
    about = "Generate Pi configuration from a preset",
    disable_help_flag = true
)]
struct Args {
    /// Preset to apply
    #[arg(value_name = "PRESET")]
    preset: Option<String>,

    /// Print help
    #[arg(short, long)]
    help: bool,
}

/// Loads the selected preset, merges it with the common configuration, and writes
/// `settings.json` and `agents.models.json`.
fn main() -> Result<()> {
    let args = Args::parse();
    let config_dir = config_dir()?;
    let presets = read_jsonc_object(&config_dir.join(PRESETS_FILE))?;

    let Some(preset_name) = args.preset.filter(|_| !args.help) else {
        print_help(&presets);
        return Ok(());
    };

    if !presets.contains_key(&preset_name) {
        bail!(
            "Preset '{preset_name}' not found in {PRESETS_FILE}\n\nAvailable presets:\n{}\n\nUsage: pi-switch <preset-name>",
            format_presets(&presets)
        );
    }

    let common = Value::Object(read_jsonc_object(&config_dir.join(COMMON_FILE))?);
    let preset = resolve_preset(&presets, &preset_name, &mut Vec::new())?;
    let merged = deep_merge(common, preset);

    // Derive both outputs before writing either so neither file is written without the other.
    let settings = merge_existing_settings(&config_dir, to_settings(&merged));
    let agent_models = to_agent_models(&merged);

    write_json(&config_dir.join(SETTINGS_FILE), &settings)?;
    write_json(&config_dir.join(AGENT_MODELS_FILE), &agent_models)?;

    println!("✓ Successfully switched to preset: {preset_name}");
    println!("✓ Generated {SETTINGS_FILE}");
    println!("✓ Generated {AGENT_MODELS_FILE}");
    print_agent_table(&agent_models);

    Ok(())
}

/// Returns the configuration directory containing this Cargo script's `bin` directory.
///
/// Cargo sets `CARGO_MANIFEST_DIR` to the directory containing the script, even when the
/// compiled script runs from Cargo's cache.
fn config_dir() -> Result<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .context("failed to locate the configuration directory")
}

/// Reads a JSONC file and requires its root value to be an object.
fn read_jsonc_object(path: &Path) -> Result<Map<String, Value>> {
    let content = fs::read_to_string(path).with_context(|| {
        if path.exists() {
            format!("failed to read {}", path.display())
        } else {
            format!("configuration file missing: {}", path.display())
        }
    })?;

    let value: Value = parse_to_serde_value(&content, &ParseOptions::default())
        .with_context(|| format!("failed to parse {}", path.display()))?;

    value
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("{} must contain a JSON object", path.display()))
}

/// Serializes a value as pretty-printed JSON with a trailing newline.
fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut content = serde_json::to_string_pretty(value).context("failed to serialize config")?;
    content.push('\n');
    fs::write(path, content).with_context(|| format!("failed to write {}", path.display()))
}

/// Resolves a preset and its ordered parent chain into one configuration object.
///
/// Later parents override earlier parents, and the selected preset overrides every parent.
/// `ancestors` tracks the active resolution path so inheritance cycles can be reported.
fn resolve_preset(
    presets: &Map<String, Value>,
    preset_name: &str,
    ancestors: &mut Vec<String>,
) -> Result<Value> {
    let preset = presets
        .get(preset_name)
        .ok_or_else(|| anyhow!("Preset '{preset_name}' not found in {PRESETS_FILE}"))?
        .as_object()
        .ok_or_else(|| anyhow!("Preset '{preset_name}' must be a JSON object"))?;

    if let Some(cycle_start) = ancestors.iter().position(|name| name == preset_name) {
        let mut cycle = ancestors[cycle_start..].to_vec();
        cycle.push(preset_name.to_owned());
        bail!(
            "Circular preset inheritance detected: {}",
            cycle.join(" -> ")
        );
    }

    let parent_names = match preset.get("extends") {
        None => return Ok(Value::Object(strip_preset_metadata(preset))),
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| {
                name.as_str().ok_or_else(|| {
                    anyhow!(
                        "Preset '{preset_name}' has invalid 'extends'; expected an array of preset names."
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?,
        Some(_) => bail!(
            "Preset '{preset_name}' has invalid 'extends'; expected an array of preset names."
        ),
    };

    ancestors.push(preset_name.to_owned());
    let inherited =
        parent_names
            .into_iter()
            .try_fold(Value::Object(Map::new()), |merged, parent_name| {
                resolve_preset(presets, parent_name, ancestors)
                    .map(|parent| deep_merge(merged, parent))
            });
    ancestors.pop();

    Ok(deep_merge(
        inherited?,
        Value::Object(strip_preset_metadata(preset)),
    ))
}

/// Removes fields used by the preset system rather than by Pi itself.
fn strip_preset_metadata(preset: &Map<String, Value>) -> Map<String, Value> {
    let mut config = preset.clone();
    config.remove("common");
    config.remove("extends");
    config
}

/// Recursively merges two JSON values using the switcher's compatibility rules.
///
/// Objects merge recursively, arrays and primitive target values replace their source values,
/// and a target `null` retains the source value. These rules match the original Node.js script.
fn deep_merge(source: Value, target: Value) -> Value {
    match (source, target) {
        (source, Value::Null) => source,
        (Value::Null, target) => target,
        (Value::Object(mut source), Value::Object(target)) => {
            for (key, target_value) in target {
                match source.get_mut(&key) {
                    Some(source_value)
                        if is_object_like(source_value) && is_object_like(&target_value) =>
                    {
                        let original = std::mem::take(source_value);
                        *source_value = deep_merge(original, target_value);
                    }
                    _ => {
                        source.insert(key, target_value);
                    }
                }
            }
            Value::Object(source)
        }
        (_, target) => target,
    }
}

/// Reports whether a value participates in recursive object merging.
///
/// JSON `null` counts as object-like here to preserve the original JavaScript merge behavior.
fn is_object_like(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Null)
}

/// Preserves local settings a user configured through Pi or by hand.
///
/// Generated values win over existing ones and unrelated local keys are kept. Missing,
/// unreadable, malformed, and non-object existing settings are ignored silently.
fn merge_existing_settings(config_dir: &Path, settings: Value) -> Value {
    let Ok(content) = fs::read_to_string(config_dir.join(SETTINGS_FILE)) else {
        return settings;
    };
    let Ok(existing) = parse_to_serde_value::<Value>(&content, &ParseOptions::default()) else {
        return settings;
    };
    if !existing.is_object() {
        return settings;
    }

    deep_merge(existing, settings)
}

/// Converts the merged preset into `settings.json` contents.
///
/// The `agent` map moves to `agents.models.json`, while `model` and `thinkingLevel` become
/// Pi's `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` settings.
fn to_settings(merged: &Value) -> Value {
    let Value::Object(mut settings) = merged.clone() else {
        return merged.clone();
    };
    settings.remove("agent");

    if let Some(model) = settings
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let (provider, default_model) = split_model(&model);
        if let Some(provider) = provider {
            settings.insert(
                "defaultProvider".to_owned(),
                Value::String(provider.to_owned()),
            );
        }
        settings.insert(
            "defaultModel".to_owned(),
            Value::String(default_model.to_owned()),
        );
    }
    settings.remove("model");

    if let Some(level) = settings
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        settings.insert("defaultThinkingLevel".to_owned(), Value::String(level));
    }
    settings.remove("thinkingLevel");

    Value::Object(settings)
}

/// Splits a `provider/model` reference on the first slash into `(provider, model)`.
///
/// A reference without a slash, or with a leading or trailing slash, has no valid provider
/// and returns `None` for it; the whole reference becomes the model.
fn split_model(model: &str) -> (Option<&str>, &str) {
    match model.find('/') {
        Some(slash) if slash > 0 && slash < model.len() - 1 => {
            (Some(&model[..slash]), &model[slash + 1..])
        }
        _ => (None, model),
    }
}

/// Converts per-agent preset entries into the `agents.models.json` contents read by the
/// bundled subagent extension.
///
/// Only object-shaped agent entries survive, and only string `model` and `thinkingLevel`
/// fields are copied.
fn to_agent_models(merged: &Value) -> Value {
    let mut models = Map::new();
    let Some(agents) = merged.get("agent").and_then(Value::as_object) else {
        return Value::Object(models);
    };

    for (name, config) in agents {
        let Some(config) = config.as_object() else {
            continue;
        };
        let mut entry = Map::new();
        if let Some(model) = config.get("model").and_then(Value::as_str) {
            entry.insert("model".to_owned(), Value::String(model.to_owned()));
        }
        if let Some(level) = config.get("thinkingLevel").and_then(Value::as_str) {
            entry.insert("thinkingLevel".to_owned(), Value::String(level.to_owned()));
        }
        models.insert(name.clone(), Value::Object(entry));
    }

    Value::Object(models)
}

/// Iterates over presets that are available for direct selection.
///
/// Presets marked with `"common": true` remain available for inheritance but are hidden here.
fn visible_preset_names(presets: &Map<String, Value>) -> impl Iterator<Item = &str> {
    presets.iter().filter_map(|(name, preset)| {
        (preset.get("common") != Some(&Value::Bool(true))).then_some(name.as_str())
    })
}

/// Formats visible preset names for help and error output.
fn format_presets(presets: &Map<String, Value>) -> String {
    visible_preset_names(presets)
        .map(|name| format!("  - {name}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Prints usage information and the presets available for direct selection.
fn print_help(presets: &Map<String, Value>) {
    println!("Pi Configuration Preset Switcher\n");
    println!("Usage: pi-switch <preset-name>\n");
    println!("Available presets:\n{}\n", format_presets(presets));
    println!("Description:");
    println!("  Merges {COMMON_FILE} with the selected preset");
    println!("  from {PRESETS_FILE} to generate {SETTINGS_FILE} and");
    println!("  {AGENT_MODELS_FILE}");
    println!("  Presets marked common: true are hidden from this list");
    println!("  and may be inherited with extends.");
}

/// Prints the agent, model, and thinking-level mappings when any agents are present.
fn print_agent_table(agent_models: &Value) {
    let Some(agents) = agent_models.as_object() else {
        return;
    };
    if agents.is_empty() {
        return;
    }

    let rows = agents
        .iter()
        .map(|(name, config)| AgentRow {
            name,
            model: string_field(config, "model").unwrap_or("-"),
            thinking_level: string_field(config, "thinkingLevel").unwrap_or("-"),
        })
        .collect::<Vec<_>>();
    let agent_width = column_width("Agent", rows.iter().map(|row| row.name));
    let model_width = column_width("Model", rows.iter().map(|row| row.model));
    let level_width = column_width("Thinking", rows.iter().map(|row| row.thinking_level));

    println!();
    println!(
        "  {0:<agent_width$} │ {1:<model_width$} │ Thinking",
        "Agent", "Model"
    );
    println!(
        "  {}─┼─{}─┼─{}",
        "─".repeat(agent_width),
        "─".repeat(model_width),
        "─".repeat(level_width)
    );
    for row in rows {
        println!(
            "  {name:<agent_width$} │ {model:<model_width$} │ {level}",
            name = row.name,
            model = row.model,
            level = row.thinking_level
        );
    }
    println!();
}

struct AgentRow<'a> {
    name: &'a str,
    model: &'a str,
    thinking_level: &'a str,
}

/// Returns the display width needed for a table column and its header.
fn column_width<'a>(header: &str, values: impl Iterator<Item = &'a str>) -> usize {
    values
        .map(|value| value.chars().count())
        .max()
        .unwrap_or(0)
        .max(header.chars().count())
}

/// Returns a string field from a JSON object, or `None` for any other shape or value type.
fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.as_object()?.get(key)?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deep_merge_merges_objects_and_replaces_arrays() {
        let source = json!({
            "nested": { "kept": true, "overridden": "old" },
            "items": [1, 2]
        });
        let target = json!({
            "nested": { "overridden": "new", "added": true },
            "items": [3]
        });

        let merged = deep_merge(source, target);

        assert_eq!(
            merged,
            json!({
                "nested": { "kept": true, "overridden": "new", "added": true },
                "items": [3]
            })
        );
    }

    #[test]
    fn deep_merge_retains_source_objects_for_null_targets() {
        let source = json!({ "nested": { "kept": true }, "replaced": "source" });
        let target = json!({ "nested": null, "replaced": null });

        let merged = deep_merge(source, target);

        assert_eq!(
            merged,
            json!({ "nested": { "kept": true }, "replaced": null })
        );
        assert_eq!(
            deep_merge(json!({ "kept": true }), Value::Null),
            json!({ "kept": true })
        );
    }

    #[test]
    fn resolve_preset_applies_parents_in_order_and_removes_metadata() -> Result<()> {
        let presets = json!({
            "base": { "common": true, "model": "base/model", "base_only": true },
            "second": { "model": "second/model" },
            "selected": {
                "extends": ["base", "second"],
                "model": "selected/model"
            }
        });
        let presets = presets
            .as_object()
            .cloned()
            .context("test presets must be an object")?;

        let resolved = resolve_preset(&presets, "selected", &mut Vec::new())?;

        assert_eq!(
            resolved,
            json!({ "model": "selected/model", "base_only": true })
        );
        Ok(())
    }

    #[test]
    fn resolve_preset_rejects_inheritance_cycles() -> Result<()> {
        let presets = json!({
            "first": { "extends": ["second"] },
            "second": { "extends": ["first"] }
        });
        let presets = presets
            .as_object()
            .cloned()
            .context("test presets must be an object")?;

        let error = resolve_preset(&presets, "first", &mut Vec::new())
            .expect_err("inheritance cycle must fail");

        assert_eq!(
            error.to_string(),
            "Circular preset inheritance detected: first -> second -> first"
        );
        Ok(())
    }

    #[test]
    fn split_model_splits_on_the_first_slash() {
        assert_eq!(
            split_model("openai/gpt-5.6-sol"),
            (Some("openai"), "gpt-5.6-sol")
        );
        assert_eq!(
            split_model("openrouter/vendor/model"),
            (Some("openrouter"), "vendor/model")
        );
        assert_eq!(split_model("gpt-5.6-sol"), (None, "gpt-5.6-sol"));
        assert_eq!(split_model("/gpt-5.6-sol"), (None, "/gpt-5.6-sol"));
        assert_eq!(split_model("openai/"), (None, "openai/"));
    }

    #[test]
    fn to_settings_maps_model_and_thinking_level() -> Result<()> {
        let merged = json!({
            "defaultTools": ["read"],
            "model": "openai/gpt-5.6-sol",
            "thinkingLevel": "high",
            "agent": { "Solo": { "model": "openai/gpt-5.6-sol" } }
        });

        let settings = to_settings(&merged);

        assert_eq!(
            settings,
            json!({
                "defaultTools": ["read"],
                "defaultProvider": "openai",
                "defaultModel": "gpt-5.6-sol",
                "defaultThinkingLevel": "high"
            })
        );
        Ok(())
    }

    #[test]
    fn to_settings_keeps_model_without_provider_and_drops_other_levels() -> Result<()> {
        let merged = json!({
            "model": "gpt-5.6-sol",
            "thinkingLevel": 3,
            "agent": {}
        });

        let settings = to_settings(&merged);

        assert_eq!(settings, json!({ "defaultModel": "gpt-5.6-sol" }));
        Ok(())
    }

    #[test]
    fn to_agent_models_keeps_object_entries_and_string_fields() -> Result<()> {
        let merged = json!({
            "agent": {
                "Solo": { "model": "openai/gpt-5.6-sol", "thinkingLevel": "high", "disabled": true },
                "Junior": { "model": 7 },
                "Explorer": "not-an-object",
                "Librarian": {}
            }
        });

        let agent_models = to_agent_models(&merged);

        assert_eq!(
            agent_models,
            json!({
                "Solo": { "model": "openai/gpt-5.6-sol", "thinkingLevel": "high" },
                "Junior": {},
                "Librarian": {}
            })
        );
        Ok(())
    }

    #[test]
    fn to_agent_models_ignores_missing_or_non_object_agents() -> Result<()> {
        assert_eq!(to_agent_models(&json!({})), json!({}));
        assert_eq!(to_agent_models(&json!({ "agent": ["Solo"] })), json!({}));
        Ok(())
    }
}

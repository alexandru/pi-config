#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const commentJson = require("comment-json");

// File paths relative to script execution directory
const COMMON_FILE = "pi.common.jsonc";
const PRESETS_FILE = "pi.presets.jsonc";
const SETTINGS_FILE = "settings.json";
const AGENT_MODELS_FILE = "agents.models.json";
const PRESET_METADATA_KEYS = new Set(["common", "extends"]);

/**
 * Copy object with all symbols (including comment metadata)
 */
function copyWithSymbols(obj) {
  // Use Object.assign to copy enumerable properties
  const result = Object.assign({}, obj);

  // Also copy symbol properties (used by comment-json for metadata)
  const symbols = Object.getOwnPropertySymbols(obj);
  symbols.forEach((sym) => {
    result[sym] = obj[sym];
  });

  return result;
}

/**
 * Deep merge two objects with comment preservation
 * - Objects are merged recursively
 * - Arrays are replaced (not merged)
 * - Primitives from target override source
 * - Comments from source are preserved where possible
 */
function deepMerge(source, target) {
  if (target === null || target === undefined) {
    return source;
  }

  if (source === null || source === undefined) {
    return target;
  }

  // Arrays are replaced, not merged
  if (Array.isArray(target)) {
    return target;
  }

  // If target is not an object, it replaces source
  if (typeof target !== "object") {
    return target;
  }

  // If source is not an object but target is, use target
  if (typeof source !== "object" || Array.isArray(source)) {
    return target;
  }

  // Both are objects - deep merge with comment preservation
  const result = copyWithSymbols(source);

  for (const key in target) {
    if (target.hasOwnProperty(key)) {
      if (
        result.hasOwnProperty(key) &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key]) &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
      ) {
        // Recursively merge nested objects
        result[key] = deepMerge(result[key], target[key]);
      } else {
        // Replace value
        result[key] = target[key];
      }
    }
  }

  return result;
}

/**
 * Strip keys that are meaningful only to pi-switch and invalid in settings.json.
 */
function stripPresetMetadata(config) {
  const result = copyWithSymbols(config);
  for (const key of PRESET_METADATA_KEYS) {
    delete result[key];
  }
  return result;
}

/**
 * Resolve a preset's inheritance chain.
 */
function resolvePreset(presets, presetName, seen = []) {
  if (!Object.prototype.hasOwnProperty.call(presets, presetName)) {
    console.error(`Error: Preset '${presetName}' not found in ${PRESETS_FILE}`);
    process.exit(1);
  }

  if (seen.includes(presetName)) {
    console.error(
      `Error: Circular preset inheritance detected: ${seen.concat(presetName).join(" -> ")}`
    );
    process.exit(1);
  }

  const preset = presets[presetName];
  const parentNames = preset.extends;
  if (parentNames === undefined) {
    return stripPresetMetadata(preset);
  }

  if (
    !Array.isArray(parentNames) ||
    parentNames.some((parentName) => typeof parentName !== "string")
  ) {
    console.error(
      `Error: Preset '${presetName}' has invalid 'extends'; expected an array of preset names.`
    );
    process.exit(1);
  }

  const nextSeen = seen.concat(presetName);
  const inherited = parentNames.reduce(
    (merged, parentName) =>
      deepMerge(merged, resolvePreset(presets, parentName, nextSeen)),
    {}
  );
  return stripPresetMetadata(deepMerge(inherited, preset));
}

/**
 * Read and parse a JSONC file
 */
function readJsoncFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return commentJson.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`Error: Configuration file missing: ${filePath}`);
      console.error("Please ensure the file exists in the current directory.");
      process.exit(1);
    } else {
      console.error(`Error: Failed to parse ${filePath}`);
      console.error(error.message);
      process.exit(1);
    }
  }
}

/**
 * Write a plain JSON file
 */
function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (error) {
    console.error(`Error: Failed to write ${filePath}`);
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Split a 'provider/model' reference into Pi's defaultProvider/defaultModel settings.
 */
function splitModel(model) {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return { defaultModel: model };
  }
  return {
    defaultProvider: model.slice(0, slash),
    defaultModel: model.slice(slash + 1),
  };
}

/**
 * Convert the merged preset into Pi's settings.json contents.
 */
function toSettings(merged) {
  const settings = copyWithSymbols(merged);
  delete settings.agent;
  if (typeof settings.model === "string") {
    Object.assign(settings, splitModel(settings.model));
  }
  delete settings.model;
  if (typeof settings.thinkingLevel === "string") {
    settings.defaultThinkingLevel = settings.thinkingLevel;
  }
  delete settings.thinkingLevel;
  return settings;
}

/**
 * Convert per-agent preset entries into the agents.models.json contents read by
 * the bundled subagent extension.
 */
function toAgentModels(merged) {
  const agents = merged.agent;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return {};
  }
  const models = {};
  for (const [name, config] of Object.entries(agents)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      continue;
    }
    const entry = {};
    if (typeof config.model === "string") {
      entry.model = config.model;
    }
    if (typeof config.thinkingLevel === "string") {
      entry.thinkingLevel = config.thinkingLevel;
    }
    models[name] = entry;
  }
  return models;
}

/**
 * Preserve local settings a user configured through Pi or by hand. Generated
 * values win; unrelated local keys are kept.
 */
function mergeExistingSettings(settings) {
  try {
    const existing = commentJson.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      return settings;
    }
    return deepMerge(existing, settings);
  } catch {
    return settings;
  }
}

/**
 * List available presets
 */
function listPresets(presets) {
  const presetNames = Object.keys(presets).filter(
    (name) => presets[name].common !== true
  );
  return presetNames.map((name) => `  - ${name}`).join("\n");
}

/**
 * Show help message
 */
function showHelp(presets) {
  console.log("Pi Configuration Preset Switcher");
  console.log("");
  console.log("Usage: pi-switch <preset-name>");
  console.log("");
  console.log("Available presets:");
  console.log(listPresets(presets));
  console.log("");
  console.log("Description:");
  console.log("  Merges pi.common.jsonc with the selected preset");
  console.log("  from pi.presets.jsonc to generate settings.json and");
  console.log("  agents.models.json");
  console.log("  Presets marked common: true are hidden from this list");
  console.log("  and may be inherited with extends.");
}

/**
 * Print the agent-to-model summary table
 */
function printSummary(agentModels) {
  const entries = Object.entries(agentModels);
  if (entries.length === 0) {
    return;
  }

  const agentWidth = Math.max(...entries.map(([name]) => name.length), 7);
  const modelWidth = Math.max(
    ...entries.map(([, config]) => (config.model || "").length),
    5
  );
  const levelWidth = Math.max(
    ...entries.map(([, config]) => (config.thinkingLevel || "-").length),
    8
  );

  const pad = (value, width) => value.padEnd(width);

  console.log("");
  console.log(
    `  ${pad("Agent", agentWidth)} │ ${pad("Model", modelWidth)} │ Thinking`
  );
  console.log(
    `  ${"─".repeat(agentWidth)}─┼─${"─".repeat(modelWidth)}─┼─${"─".repeat(levelWidth)}`
  );
  for (const [name, config] of entries) {
    const model = config.model || "-";
    const thinkingLevel = config.thinkingLevel || "-";
    console.log(
      `  ${pad(name, agentWidth)} │ ${pad(model, modelWidth)} │ ${thinkingLevel}`
    );
  }
  console.log("");
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);

  // Load presets file first to show in help
  const presets = readJsoncFile(PRESETS_FILE);

  // Show help if no arguments
  if (args.length === 0) {
    showHelp(presets);
    process.exit(0);
  }

  const presetName = args[0];

  // Check if preset exists
  if (!presets.hasOwnProperty(presetName)) {
    console.error(`Error: Preset '${presetName}' not found in ${PRESETS_FILE}`);
    console.error("");
    console.error("Available presets:");
    console.error(listPresets(presets));
    console.error("");
    console.error("Usage: pi-switch <preset-name>");
    process.exit(1);
  }

  // Load common configuration
  const common = readJsoncFile(COMMON_FILE);

  // Get selected preset, including any inherited preset config
  const preset = resolvePreset(presets, presetName);

  // Merge configurations
  const merged = deepMerge(common, preset);

  // Write generated configuration
  const settings = mergeExistingSettings(toSettings(merged));
  const agentModels = toAgentModels(merged);
  writeJsonFile(SETTINGS_FILE, settings);
  writeJsonFile(AGENT_MODELS_FILE, agentModels);

  console.log(`✓ Successfully switched to preset: ${presetName}`);
  console.log(`✓ Generated ${SETTINGS_FILE}`);
  console.log(`✓ Generated ${AGENT_MODELS_FILE}`);

  printSummary(agentModels);
}

// Run
main();

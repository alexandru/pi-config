# Pi configuration

Configuration for [Pi Coding Agent](https://pi.dev/). It provides the shared skills, prompt templates, and the Orchestrator/Explorer/Librarian/Junior role model used by the other configurations in this repository.

## Install

Install Pi, then point its agent directory at this folder:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
export PI_CODING_AGENT_DIR="/absolute/path/to/agents-config/pi"
pi
```

Add the `PI_CODING_AGENT_DIR` export to your shell profile to make it persistent. The bundled `subagent` extension starts child `pi` processes, so `pi` must remain on `PATH`.

The configuration has no `auth.json`, model settings, or other machine-specific state. Authenticate and choose models through Pi's normal mechanisms.

## Included resources

- `AGENTS.md`: Orchestrator instructions loaded globally by Pi.
- `extensions/subagent/`: isolated, named Pi child agents. It supports one task, up to four parallel tasks, and chains whose later tasks use `{previous}`.
- `agents/`: `Explorer`, `Librarian`, and `Junior` role definitions. Project-local agents are opt-in through `agentScope: "project"` or `"both"` and require interactive confirmation by default.
- `prompts/`: `/grill-me`, `/handoff`, `/plan`, `/review`, and `/simplify`.
- `skills/`: shared vendored skills. Refresh them manually with `make update-skills`, inspect the resulting diff, and keep only reviewed changes.

The subagent extension follows Pi's documented subagent extension example, adapted to use this repository's role names and the active model rather than provider-specific defaults. It requires Pi 0.84.2 or later.

## Skills

Initialize or refresh vendored skills:

```sh
make update-skills
```

For the `cellar` skill, install its CLI separately:

```sh
cs install --contrib cellar
cellar --version
cellar telemetry disable
```

## References

- [Pi documentation](https://pi.dev/docs/latest)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi skills](https://pi.dev/docs/latest/skills)
- [Pi subagent extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)

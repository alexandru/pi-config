import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

function parseTools(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
	return tools.length === 0 ? undefined : tools;
}

function loadAgents(directory: string, source: "user" | "project"): AgentConfig[] {
	try {
		return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) return [];
			try {
				const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(
					fs.readFileSync(path.join(directory, entry.name), "utf8"),
				);
				if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return [];
				return [{
					name: frontmatter.name,
					description: frontmatter.description,
					tools: parseTools(frontmatter.tools),
					model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
					systemPrompt: body,
					source,
				}];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function findProjectAgents(cwd: string): string | undefined {
	let directory = cwd;
	while (true) {
		const candidate = path.join(directory, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Continue to the parent directory.
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const user = scope === "project" ? [] : loadAgents(path.join(getAgentDir(), "agents"), "user");
	const projectDirectory = findProjectAgents(cwd);
	const project = scope === "user" || !projectDirectory ? [] : loadAgents(projectDirectory, "project");
	const agents = new Map<string, AgentConfig>();
	for (const agent of user) agents.set(agent.name, agent);
	for (const agent of project) agents.set(agent.name, agent);
	return [...agents.values()];
}

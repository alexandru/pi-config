import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 4;

const Task = Type.Object({
	agent: Type.String({ description: "Configured agent name" }),
	task: Type.String({ description: "Self-contained task for the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
});

const ChainTask = Type.Object({
	agent: Type.String({ description: "Configured agent name" }),
	task: Type.String({ description: "Task; {previous} is replaced by preceding output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
});

const Parameters = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent for one task" })),
	task: Type.Optional(Type.String({ description: "Self-contained task for one agent" })),
	tasks: Type.Optional(Type.Array(Task, { description: "Independent tasks to run in parallel (maximum four)" })),
	chain: Type.Optional(Type.Array(ChainTask, { description: "Sequential tasks; later tasks may use {previous}" })),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Confirm before running project-local agent definitions", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a single task" })),
});

type Result = {
	agent: string;
	source: "user" | "project" | "unknown";
	task: string;
	output: string;
	stderr: string;
	exitCode: number;
};

function invocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function finalAssistantText(line: string): string | undefined {
	try {
		const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
		if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
		return event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
	} catch {
		return undefined;
	}
}

async function runAgent(
	agent: AgentConfig | undefined,
	task: string,
	cwd: string,
	model: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Result> {
	if (!agent) {
		return { agent: "unknown", source: "unknown", task, output: "", stderr: "Unknown configured agent.", exitCode: 1 };
	}

	const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const promptPath = path.join(tempDirectory, "system.md");
	try {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
		const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath];
		if (model) args.push("--model", model);
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
		args.push(`Task: ${task}`);

		return await new Promise<Result>((resolve) => {
			const child = invocation(args);
			const process = spawn(child.command, child.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let output = "";
			let aborted = false;
			process.stdout.on("data", (data) => {
				stdout += data.toString();
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const line of lines) output = finalAssistantText(line) ?? output;
			});
			process.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			process.on("error", (error) => {
				stderr += error.message;
			});
			process.on("close", (code) => {
				output = finalAssistantText(stdout) ?? output;
				resolve({
					agent: agent.name,
					source: agent.source,
					task,
					output: output || (aborted ? "Subagent was aborted." : "(no output)"),
					stderr,
					exitCode: aborted ? 1 : (code ?? 1),
				});
			});
			const abort = () => {
				aborted = true;
				process.kill("SIGTERM");
				setTimeout(() => process.kill("SIGKILL"), 5000).unref();
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
	} finally {
		await fs.promises.rm(tempDirectory, { recursive: true, force: true });
	}
}

function formatResult(result: Result): string {
	const status = result.exitCode === 0 ? "completed" : "failed";
	const detail = result.exitCode === 0 ? result.output : result.stderr || result.output;
	return `### ${result.agent} (${status})\n\n${detail}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a bounded task to Explorer, Librarian, or Junior in an isolated Pi process.",
			"Use single mode, independent parallel tasks, or an ordered chain using {previous}.",
			`User agents are loaded from ${path.join(getAgentDir(), "agents")}; project agents are opt-in.`,
		].join(" "),
		parameters: Parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = (params.agentScope ?? "user") as AgentScope;
			const agents = discoverAgents(ctx.cwd, scope);
			const lookup = (name: string) => agents.find((agent) => agent.name === name);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const single = params.agent && params.task ? { agent: params.agent, task: params.task, cwd: params.cwd } : undefined;
			const modes = Number(Boolean(single)) + Number((params.tasks?.length ?? 0) > 0) + Number((params.chain?.length ?? 0) > 0);
			if (modes !== 1) {
				return {
					content: [{ type: "text", text: `Provide exactly one mode. Available agents: ${agents.map((agent) => agent.name).join(", ") || "none"}.` }],
					isError: true,
				};
			}
			const requestedNames = new Set([
				...(single ? [single.agent] : []),
				...(params.tasks?.map((item) => item.agent) ?? []),
				...(params.chain?.map((item) => item.agent) ?? []),
			]);
			const projectAgents = [...requestedNames].map(lookup).filter((agent) => agent?.source === "project");
			if (projectAgents.length > 0 && params.confirmProjectAgents !== false && ctx.hasUI) {
				const approved = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${projectAgents.map((agent) => agent!.name).join(", ")}\n\nProject agent instructions are repository-controlled. Continue only for a trusted project.`,
				);
				if (!approved) return { content: [{ type: "text", text: "Canceled: project-local agents were not approved." }] };
			}

			if (single) {
				const result = await runAgent(lookup(single.agent), single.task, single.cwd ?? ctx.cwd, model, signal);
				return { content: [{ type: "text", text: formatResult(result) }], details: { scope, results: [result] }, isError: result.exitCode !== 0 };
			}

			if (params.tasks) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return { content: [{ type: "text", text: `At most ${MAX_PARALLEL_TASKS} parallel tasks are allowed.` }], isError: true };
				}
				const results = await Promise.all(params.tasks.map((item) => runAgent(lookup(item.agent), item.task, item.cwd ?? ctx.cwd, model, signal)));
				return {
					content: [{ type: "text", text: results.map(formatResult).join("\n\n---\n\n") }],
					details: { scope, results },
					isError: results.some((result) => result.exitCode !== 0),
				};
			}

			const results: Result[] = [];
			let previous = "";
			for (const item of params.chain ?? []) {
				const task = item.task.replaceAll("{previous}", previous);
				const result = await runAgent(lookup(item.agent), task, item.cwd ?? ctx.cwd, model, signal);
				results.push(result);
				if (result.exitCode !== 0) break;
				previous = result.output;
			}
			return {
				content: [{ type: "text", text: results.map(formatResult).join("\n\n---\n\n") }],
				details: { scope, results },
				isError: results.some((result) => result.exitCode !== 0),
			};
		},
	});
}

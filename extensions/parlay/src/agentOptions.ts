import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent } from "./handoff";

export interface AgentOptions { model: string; effort: string; fast: boolean }
export function agentOptions(agent: Agent): AgentOptions {
	const cfg = vscode.workspace.getConfiguration(`parlay.${agent === "gpt" ? "codex" : "claude"}`);
	return { model: cfg.get("model", ""), effort: cfg.get("effort", ""), fast: cfg.get("fast", false) };
}
export function optionArgs(agent: Agent, options = agentOptions(agent)): string[] {
	return agent === "claude" ? [
		...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--effort", options.effort] : []),
		"--settings", JSON.stringify({ fastMode: options.fast }),
	] : [
		...(options.model ? ["-m", options.model] : []), ...(options.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []),
		"-c", `service_tier=${JSON.stringify(options.fast ? "fast" : "default")}`,
	];
}
function catalog(): { slug: string; display_name?: string; supported_reasoning_levels?: { effort: string }[] }[] {
	try { return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json"), "utf8")).models ?? []; } catch { return []; }
}
export async function configureAgent(agent: Agent, field: "model" | "effort" | "fast") {
	const options = agentOptions(agent);
	let value: string | boolean | undefined;
	if (field === "fast") value = !options.fast;
	else if (field === "model") {
		const models = agent === "gpt" ? catalog().map(m => ({ label: m.display_name || m.slug, value: m.slug })) : ["fable", "opus", "sonnet", "haiku"].map(value => ({ label: value, value }));
		const chosen = await vscode.window.showQuickPick([{ label: "Default model", value: "" }, ...models, { label: "Enter model ID…", value: "custom" }], { title: "Model", placeHolder: "Choose a model available to your account" });
		if (!chosen) return false;
		value = chosen.value === "custom" ? await vscode.window.showInputBox({ title: "Model ID", value: options.model, validateInput: input => /^[a-zA-Z0-9][a-zA-Z0-9._:/()[\]-]*$/.test(input) ? undefined : "Enter a model ID or alias." }) : chosen.value;
	} else {
		const supported = agent === "gpt" ? catalog().find(m => m.slug === options.model)?.supported_reasoning_levels?.map(level => level.effort) : undefined;
		const efforts = supported ?? (agent === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh"]);
		value = (await vscode.window.showQuickPick([{ label: "Default thinking", value: "" }, ...efforts.map(value => ({ label: value, value }))], { title: "Thinking effort", placeHolder: "Higher effort allows more reasoning; support depends on the model" }))?.value;
	}
	if (value === undefined) return false;
	await vscode.workspace.getConfiguration(`parlay.${agent === "gpt" ? "codex" : "claude"}`).update(field, value, vscode.ConfigurationTarget.Global);
	return true;
}

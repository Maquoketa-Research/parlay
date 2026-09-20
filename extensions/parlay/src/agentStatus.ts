// Ask the installed CLIs about authentication without reading or storing their credentials.
import { execFile } from "child_process";
import type { Agent } from "./handoff";

export interface AgentStatus { installed: boolean; authenticated: boolean; label: string }

export function agentStatus(file: string, agent: Agent): Promise<AgentStatus> {
	return new Promise(resolve => {
		execFile(file, agent === "claude" ? ["auth", "status"] : ["login", "status"], { windowsHide: true, timeout: 8000 }, (error, stdout, stderr) => {
			if (error && ["ENOENT", "EACCES"].includes(String(error.code))) {
				resolve({ installed: false, authenticated: false, label: "Not installed" }); return;
			}
			let authenticated = false;
			if (agent === "claude") {
				try { authenticated = JSON.parse(stdout.trim()).loggedIn === true; } catch { /* CLI unavailable or not authenticated */ }
			} else authenticated = !error && /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr);
			resolve({ installed: true, authenticated, label: authenticated ? "Connected" : error?.killed ? "Status unavailable" : "Sign in required" });
		});
	});
}

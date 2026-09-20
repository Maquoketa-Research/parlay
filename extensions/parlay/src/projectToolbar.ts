import * as vscode from "vscode";
import { configureMacSync } from "./studio";
import { execFile } from "child_process";

export function registerProjectToolbar(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.project.select", async () => {
		const choice = await vscode.window.showQuickPick([
			{ label: "$(folder-opened) Open game folder…", description: "Choose your game's Script Sync folder", command: "workbench.action.files.openFolder" },
			{ label: "$(history) Recent projects…", description: "Reopen a recent folder or workspace", command: "workbench.action.openRecent" },
		], { title: "Game project", placeHolder: "Choose a game project" });
		if (choice) await vscode.commands.executeCommand(choice.command);
	}));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.scriptSync", async () => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) { await vscode.commands.executeCommand("parlay.project.select"); return; }
		const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Which folder should Studio sync?" });
		if (!folder) return;
		const choice = await vscode.window.showQuickPick([
			...(process.platform === "darwin" ? [{ label: "$(sync) Set up folders automatically…", description: "Quit Studio, configure Script Sync, and reopen the place", action: "setup" }] : []),
			{ label: "$(copy) Copy project folder path", description: folder.uri.fsPath, action: "copy" },
			{ label: "$(link-external) Open Script Sync guide", description: "Roblox's setup instructions", action: "guide" },
		], { title: "Script Sync", placeHolder: process.platform === "darwin" ? "Set up the project’s sync folders or copy its path." : "In Studio, right-click a script container, choose Sync to…, and select this folder." });
		if (choice?.action === "setup") {
			await configureMacSync(ctx, folder.uri.fsPath);
		} else if (choice?.action === "copy") {
			await vscode.env.clipboard.writeText(folder.uri.fsPath);
			void vscode.window.showInformationMessage("Project path copied. In Roblox Studio, choose Sync to… on a script container and select this folder.");
		} else if (choice?.action === "guide") {
			await vscode.env.openExternal(vscode.Uri.parse("https://create.roblox.com/docs/scripting/sync"));
		}
	}));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.studio.open", async () => {
		if (process.platform !== "darwin") {
			void vscode.window.showInformationMessage("Open Roblox Studio to playtest your game.");
			return;
		}
		await new Promise<void>((resolve, reject) => execFile("open", ["-b", "com.Roblox.RobloxStudio"], error => error ? reject(error) : resolve()));
	}));
}

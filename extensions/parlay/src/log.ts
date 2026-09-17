// View > Output > Parlay: what each step found, for when "nothing happened". A log channel, so it also lands in
// the extension host's log folder on disk. Its own module so that any file can import it without a cycle.
import * as vscode from "vscode";

export const log = vscode.window.createOutputChannel("Parlay", { log: true });

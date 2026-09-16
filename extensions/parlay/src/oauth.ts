// One OAuth 2.0 authorization-code + PKCE (S256) client behind vscode.AuthenticationProvider; roblox-auth.ts and
// discord-auth.ts are its two configurations. The account sits in the Accounts menu, avatar included (the
// authSessionAccountIcon proposal, enabled in package.json), and the rest of Parlay asks
// vscode.authentication.getSession(id, scopes, ...) the way it would for GitHub.
// Both apps are confidential clients: PKCE rides on top of a client secret kept in SecretStorage, never in settings.
// The browser comes back to a one-shot loopback server on one of two fixed ports, both registered on the app as
// redirect URLs. Refresh tokens are single-use on both providers: the reply's refresh_token replaces the stored one.
// Names follow the provider id: setting parlay.<id>ClientId, secrets parlay.<id>ClientSecret and parlay.<id>Session.
// The secret itself: the one the user typed (SecretStorage) if any, else the one the build baked into
// secrets.json next to package.json (build-win32.sh writes it from ~/.parlay/<id>-client-secret; the file is
// gitignored), else a one-time prompt. So an installed Parlay signs in with no setup at all.
import * as vscode from "vscode";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as pkce from "./pkce";

const PORTS = [53682, 53683];
export const REDIRECTS = PORTS.map((p) => `http://localhost:${p}/callback`);

export interface User { id: string; name: string; displayName: string; avatar?: string }
export interface Provider {
	id: string; label: string;                        // provider id and its name in the Accounts menu
	authorizeUrl: string; tokenUrl: string; userinfoUrl: string; revokeUrl: string;
	scopes: string[];                                  // always asked for, on top of what a caller wants
	dashboardUrl: string;                              // where the app gets registered
	setupSteps: string;                                // the one-time setup, shown while parlay.<id>ClientId is empty
	parseUser(json: any): User | Promise<User>;        // the userinfo reply -> user; may go fetch the avatar
}

interface Stored { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[]; user: User }
interface Tok { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
class HttpError extends Error { constructor(readonly status: number, m: string) { super(m); } }

const form = (o: Record<string, string>) => new URLSearchParams(o).toString().replace(/\+/g, "%20");
const toSession = (s: Stored): vscode.AuthenticationSession => ({
	id: s.user.id, accessToken: s.accessToken, scopes: s.scopes,
	account: {
		id: s.user.id, label: s.user.displayName === s.user.name ? s.user.name : `${s.user.displayName} (@${s.user.name})`,
		icon: s.user.avatar ? vscode.Uri.parse(s.user.avatar) : undefined,
	},
});
const pack = (t: Tok, asked: string[], prevRefresh = "") => ({
	accessToken: t.access_token, refreshToken: t.refresh_token ?? prevRefresh, expiresAt: Date.now() + t.expires_in * 1000,
	scopes: t.scope?.split(" ").filter(Boolean) ?? asked,
});

export function register(ctx: vscode.ExtensionContext, p: Provider): OAuthProvider {
	const a = new OAuthProvider(ctx, p);
	ctx.subscriptions.push(vscode.authentication.registerAuthenticationProvider(p.id, p.label, a, { supportsMultipleAccounts: false }));
	return a;
}

// Who is signed in to a provider (for the Accounts page); undefined when nobody is.
export async function accountInfo(ctx: vscode.ExtensionContext, providerId: string): Promise<User | undefined> {
	const raw = await ctx.secrets.get(`parlay.${providerId}Session`);
	return raw ? (JSON.parse(raw) as Stored).user : undefined;
}

export class OAuthProvider implements vscode.AuthenticationProvider {
	private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this.changed.event;
	private refreshing?: Promise<Stored | undefined>;
	private readonly store: string;
	private readonly secretKey: string;
	constructor(private readonly ctx: vscode.ExtensionContext, private readonly p: Provider) {
		this.store = `parlay.${p.id}Session`;
		this.secretKey = `parlay.${p.id}ClientSecret`;
	}

	private clientId() { return vscode.workspace.getConfiguration("parlay").get<string>(`${this.p.id}ClientId`, "").trim(); }

	// The one-time setup, spelled out where the user hits it. True when it had to be shown.
	async needsSetup(): Promise<boolean> {
		if (this.clientId()) return false;
		const pick = await vscode.window.showInformationMessage(`Parlay needs a ${this.p.label} OAuth 2.0 app (once).`, { modal: true, detail: this.p.setupSteps }, "Open Developer Portal", "Open Settings");
		if (pick === "Open Developer Portal") void vscode.env.openExternal(vscode.Uri.parse(this.p.dashboardUrl));
		if (pick === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", `parlay.${this.p.id}ClientId`);
		return true;
	}

	// ---- vscode.AuthenticationProvider ----

	async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		let s = await this.stored();
		if (s && s.expiresAt - Date.now() < 60_000) s = await (this.refreshing ??= this.refresh(s).finally(() => { this.refreshing = undefined; }));
		if (!s || scopes?.some((x) => !s!.scopes.includes(x))) return [];
		return [toSession(s)];
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const { label } = this.p;
		if (await this.needsSetup()) throw new Error(`${label} OAuth app not configured (parlay.${this.p.id}ClientId)`);
		const secret = await this.secret(true);
		const verifier = pkce.verifier(), state = randomBytes(16).toString("hex");
		const want = Array.from(new Set([...this.p.scopes, ...scopes]));
		const { code, redirectUri } = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Signing in to ${label} in your browser…`, cancellable: true },
			(_p, token) => callback(label, state, token, (redirectUri) => vscode.env.openExternal(vscode.Uri.parse(`${this.p.authorizeUrl}?` + form({
				client_id: this.clientId(), redirect_uri: redirectUri, scope: want.join(" "), response_type: "code", state,
				code_challenge: pkce.challenge(verifier), code_challenge_method: "S256",
			})))));
		const tok = await this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, secret);
		const user = await this.p.parseUser(await this.json(this.p.userinfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } }));
		const s = await this.save({ ...pack(tok, want), user });
		this.changed.fire({ added: [toSession(s)], removed: undefined, changed: undefined });
		return toSession(s);
	}

	async removeSession(): Promise<void> {
		const s = await this.stored();
		if (!s) return;
		const secret = await this.secret(false).catch(() => undefined);
		// revoking the refresh token ends the whole grant; if the provider is unreachable the local sign-out still happens
		if (secret) await fetch(this.p.revokeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: s.refreshToken, client_id: this.clientId(), client_secret: secret }) }).catch(() => undefined);
		await this.ctx.secrets.delete(this.store);
		this.changed.fire({ added: undefined, removed: [toSession(s)], changed: undefined });
	}

	// ---- the commands ----

	async signIn() {
		if (await this.needsSetup()) return;
		try {
			const s = await vscode.authentication.getSession(this.p.id, this.p.scopes, { createIfNone: true });
			void vscode.window.showInformationMessage(`Parlay: signed in to ${this.p.label} as ${s.account.label}.`);
		} catch (e) {
			if (!/cancel|consent/i.test((e as Error).message)) void vscode.window.showErrorMessage(`Parlay: ${this.p.label} sign-in failed. ${(e as Error).message}`);
		}
	}

	async signOut() {
		const s = await this.stored();
		if (!s) { void vscode.window.showInformationMessage(`Parlay: not signed in to ${this.p.label}.`); return; }
		await this.removeSession();
		void vscode.window.showInformationMessage(`Parlay: signed out of ${this.p.label} (${s.user.name}).`);
	}

	// ---- tokens ----

	private async json(url: string, init: RequestInit): Promise<any> {
		const r = await fetch(url, init);
		if (!r.ok) throw new HttpError(r.status, `${this.p.label} ${r.status} on ${new URL(url).pathname}: ${(await r.text()).slice(0, 200)}`);
		return r.json();
	}

	private token(body: Record<string, string>, secret: string): Promise<Tok> {
		return this.json(this.p.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: this.clientId(), client_secret: secret, ...body }) });
	}

	private async refresh(s: Stored): Promise<Stored | undefined> {
		try {
			const n = await this.save({ ...pack(await this.token({ grant_type: "refresh_token", refresh_token: s.refreshToken }, await this.secret(false)), s.scopes, s.refreshToken), user: s.user });
			this.changed.fire({ added: undefined, removed: undefined, changed: [toSession(n)] });
			return n;
		} catch (e) {
			if (!(e instanceof HttpError)) return s;   // offline: keep the session, the next call retries
			// a dead refresh token (revoked, idle past its life, secret regenerated): signed out, said once
			await this.ctx.secrets.delete(this.store);
			this.changed.fire({ added: undefined, removed: [toSession(s)], changed: undefined });
			void vscode.window.showWarningMessage(`Parlay: ${this.p.label} sign-in expired (${(e as Error).message}). Run Parlay: Sign in to ${this.p.label}.`);
			return undefined;
		}
	}

	private async stored(): Promise<Stored | undefined> { const raw = await this.ctx.secrets.get(this.store); return raw ? JSON.parse(raw) as Stored : undefined; }
	private async save(s: Stored) { await this.ctx.secrets.store(this.store, JSON.stringify(s)); return s; }

	private async secret(prompt: boolean): Promise<string> {
		let v = (await this.ctx.secrets.get(this.secretKey)) || this.baked();
		if (!v && prompt) {
			v = (await vscode.window.showInputBox({ prompt: `Client Secret of the ${this.p.label} OAuth 2.0 app Parlay signs in as. Kept in SecretStorage.`, password: true, ignoreFocusOut: true }))?.trim();
			if (v) await this.ctx.secrets.store(this.secretKey, v);
		}
		if (!v) throw new Error(`${this.p.label} client secret not set (run Parlay: Sign in to ${this.p.label})`);
		return v;
	}

	// the secret the build baked in, if this build has one for this provider
	private baked(): string | undefined {
		try { return (JSON.parse(fs.readFileSync(path.join(this.ctx.extensionPath, "secrets.json"), "utf8")) as Record<string, string>)[this.p.id] || undefined; }
		catch { return undefined; }
	}
}

// A one-shot http server on the first free of PORTS (loopback only: no firewall prompt); opens the browser once it
// listens and resolves with the code the provider redirects back with, after checking state.
function callback(label: string, state: string, token: vscode.CancellationToken, open: (redirectUri: string) => Thenable<boolean>): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		let i = 0;
		const done = (e?: Error, code?: string) => { clearTimeout(t); sub.dispose(); server.close(); e ? reject(e) : resolve({ code: code!, redirectUri: REDIRECTS[i] }); };
		const t = setTimeout(() => done(new Error(`${label} sign-in timed out`)), 5 * 60_000);
		const sub = token.onCancellationRequested(() => done(new Error("Cancelled")));
		const server = http.createServer((req, res) => {
			const u = new URL(req.url ?? "/", "http://localhost");
			if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
			const err = u.searchParams.get("error"), code = u.searchParams.get("code");
			const ok = !err && !!code && u.searchParams.get("state") === state;
			const text = ok ? `Signed in to ${label}. You can close this tab and go back to Parlay.` : `${label} sign-in failed: ${err ?? "state mismatch"}`;
			res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Parlay</title><body style="font:15px system-ui;padding:3em;text-align:center">${text.replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;")}`);
			done(ok ? undefined : new Error(err ? `${label}: ${err} ${u.searchParams.get("error_description") ?? ""}`.trim() : "state mismatch on the callback"), code ?? undefined);
		});
		server.on("error", (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE" && i + 1 < PORTS.length ? server.listen(PORTS[++i], "127.0.0.1") : done(e));
		server.on("listening", () => void open(REDIRECTS[i]));
		server.listen(PORTS[i], "127.0.0.1");
	});
}

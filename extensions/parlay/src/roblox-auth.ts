// Log in with Roblox: OAuth 2.0 authorization code + PKCE (S256) against Roblox's OpenID provider, exposed as a
// VS Code AuthenticationProvider ("roblox"), so the account sits in the Accounts menu and the rest of Parlay asks
// vscode.authentication.getSession("roblox", scopes, ...) the way it would for GitHub.
//
// Verified 2026-09-15 against the live discovery document (https://apis.roblox.com/oauth/.well-known/openid-configuration)
// and https://create.roblox.com/docs/cloud/auth/oauth2-reference :
//   authorize  GET  https://apis.roblox.com/oauth/v1/authorize       code_challenge_method=S256, state
//   token      POST https://apis.roblox.com/oauth/v1/token           grant_type authorization_code | refresh_token
//   userinfo   GET  https://apis.roblox.com/oauth/v1/userinfo        sub (user id), preferred_username, name (display name)
//   revoke     POST https://apis.roblox.com/oauth/v1/token/revoke    token = the refresh token
//   authorization codes live one minute, access tokens 15 minutes, refresh tokens 90 days and are single-use:
//   every refresh hands back a new refresh token, so the stored one is replaced on the spot.
// Roblox has no public clients (token_endpoint_auth_methods_supported: client_secret_post, client_secret_basic),
// so PKCE rides on top of the app's client secret, kept in SecretStorage (parlay.robloxClientSecret), never in
// settings. The redirect must match a registered URL exactly and localhost http is allowed
// (https://create.roblox.com/docs/cloud/auth/oauth2-registration), hence a callback served on one of two fixed ports.
// Scopes: openid and profile are identity scopes; the Open Cloud ones are documented per API: asset:read and
// asset:write (https://create.roblox.com/docs/cloud/open-cloud/usage-assets), universe-messaging-service:publish
// (https://create.roblox.com/docs/cloud/guides/usage-messaging). The Instance resource lists API Key only, no OAuth
// 2.0 (https://create.roblox.com/docs/cloud/reference/Instance), which is why studio.ts keeps its key path.
import * as vscode from "vscode";
import { randomBytes } from "crypto";
import * as http from "http";
import * as pkce from "./pkce";

const OAUTH = "https://apis.roblox.com/oauth/v1";
const PORTS = [53682, 53683];   // both registered as redirect URLs: http://localhost:<port>/callback
const DASHBOARD = "https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab";
const STORE = "parlay.robloxSession", SECRET = "parlay.robloxClientSecret";
export const SCOPES = ["openid", "profile", "asset:read", "asset:write", "universe-messaging-service:publish"];

interface Stored { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[]; user: { id: string; name: string; displayName: string } }
interface Tok { access_token: string; refresh_token: string; expires_in: number; scope?: string }
class HttpError extends Error { constructor(readonly status: number, m: string) { super(m); } }

const redirect = (port: number) => `http://localhost:${port}/callback`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString().replace(/\+/g, "%20");
const toSession = (s: Stored): vscode.AuthenticationSession => ({
	id: s.user.id, accessToken: s.accessToken, scopes: s.scopes,
	account: { id: s.user.id, label: s.user.displayName === s.user.name ? s.user.name : `${s.user.displayName} (@${s.user.name})` },
});

async function json(url: string, init: RequestInit): Promise<any> {
	const r = await fetch(url, init);
	if (!r.ok) throw new HttpError(r.status, `Roblox ${r.status} on ${url.slice(OAUTH.length + 1)}: ${(await r.text()).slice(0, 200)}`);
	return r.json();
}

export function registerRobloxAuth(ctx: vscode.ExtensionContext): RobloxAuth {
	const p = new RobloxAuth(ctx);
	ctx.subscriptions.push(vscode.authentication.registerAuthenticationProvider("roblox", "Roblox", p, { supportsMultipleAccounts: false }));
	return p;
}

export class RobloxAuth implements vscode.AuthenticationProvider {
	private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this.changed.event;
	private refreshing?: Promise<Stored | undefined>;
	constructor(private readonly ctx: vscode.ExtensionContext) {}

	private clientId() { return vscode.workspace.getConfiguration("parlay").get<string>("robloxClientId", "").trim(); }

	// The one-time setup, spelled out where the user hits it. True when it had to be shown.
	async needsSetup(): Promise<boolean> {
		if (this.clientId()) return false;
		const pick = await vscode.window.showInformationMessage("Parlay needs a Roblox OAuth 2.0 app (once, on an ID-verified Roblox account).", {
			modal: true,
			detail: "1. Creator Dashboard → Open Cloud → OAuth 2.0 Apps → Create App (the name must be unique across Roblox). Copy the Client ID and the Client Secret; the secret shows once.\n"
				+ `2. Redirect URLs: ${PORTS.map(redirect).join("  and  ")}\n`
				+ `3. Permissions: ${SCOPES.join(", ")}\n`
				+ "4. Put the Client ID in the setting parlay.robloxClientId, then run Parlay: Sign in to Roblox again; it asks for the secret once and keeps it in SecretStorage.",
		}, "Open Creator Dashboard", "Open Settings");
		if (pick === "Open Creator Dashboard") void vscode.env.openExternal(vscode.Uri.parse(DASHBOARD));
		if (pick === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "parlay.robloxClientId");
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
		if (await this.needsSetup()) throw new Error("Roblox OAuth app not configured (parlay.robloxClientId)");
		const secret = await this.secret(true);
		const verifier = pkce.verifier(), state = randomBytes(16).toString("hex");
		const want = Array.from(new Set([...SCOPES, ...scopes]));
		const { code, redirectUri } = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Signing in to Roblox in your browser…", cancellable: true },
			(_p, token) => callback(state, token, (redirectUri) => vscode.env.openExternal(vscode.Uri.parse(`${OAUTH}/authorize?` + form({
				client_id: this.clientId(), redirect_uri: redirectUri, scope: want.join(" "), response_type: "code", state,
				code_challenge: pkce.challenge(verifier), code_challenge_method: "S256",
			})))));
		const tok = await this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, secret);
		const me = await json(`${OAUTH}/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } }) as { sub: string; preferred_username: string; name?: string };
		const s = await this.save({ ...pack(tok, want), user: { id: me.sub, name: me.preferred_username, displayName: me.name || me.preferred_username } });
		this.changed.fire({ added: [toSession(s)], removed: undefined, changed: undefined });
		return toSession(s);
	}

	async removeSession(): Promise<void> {
		const s = await this.stored();
		if (!s) return;
		const secret = await this.ctx.secrets.get(SECRET);
		// revoking the refresh token ends the whole grant; if Roblox is unreachable the local sign-out still happens
		if (secret) await fetch(`${OAUTH}/token/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: s.refreshToken, client_id: this.clientId(), client_secret: secret }) }).catch(() => undefined);
		await this.ctx.secrets.delete(STORE);
		this.changed.fire({ added: undefined, removed: [toSession(s)], changed: undefined });
	}

	// ---- the commands ----

	async signIn() {
		if (await this.needsSetup()) return;
		try {
			const s = await vscode.authentication.getSession("roblox", SCOPES, { createIfNone: true });
			void vscode.window.showInformationMessage(`Parlay: signed in to Roblox as ${s.account.label}.`);
		} catch (e) {
			if (!/cancel|consent/i.test((e as Error).message)) void vscode.window.showErrorMessage(`Parlay: Roblox sign-in failed. ${(e as Error).message}`);
		}
	}

	async signOut() {
		const s = await this.stored();
		if (!s) { void vscode.window.showInformationMessage("Parlay: not signed in to Roblox."); return; }
		await this.removeSession();
		void vscode.window.showInformationMessage(`Parlay: signed out of Roblox (${s.user.name}).`);
	}

	// ---- tokens ----

	private token(body: Record<string, string>, secret: string): Promise<Tok> {
		return json(`${OAUTH}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: this.clientId(), client_secret: secret, ...body }) });
	}

	private async refresh(s: Stored): Promise<Stored | undefined> {
		try {
			const n = await this.save({ ...pack(await this.token({ grant_type: "refresh_token", refresh_token: s.refreshToken }, await this.secret(false)), s.scopes), user: s.user });
			this.changed.fire({ added: undefined, removed: undefined, changed: [toSession(n)] });
			return n;
		} catch (e) {
			if (!(e instanceof HttpError)) return s;   // offline: keep the session, the next call retries
			// a dead refresh token (revoked, 90 days idle, secret regenerated): signed out, said once
			await this.ctx.secrets.delete(STORE);
			this.changed.fire({ added: undefined, removed: [toSession(s)], changed: undefined });
			void vscode.window.showWarningMessage(`Parlay: Roblox sign-in expired (${(e as Error).message}). Run Parlay: Sign in to Roblox.`);
			return undefined;
		}
	}

	private async stored(): Promise<Stored | undefined> { const raw = await this.ctx.secrets.get(STORE); return raw ? JSON.parse(raw) as Stored : undefined; }
	private async save(s: Stored) { await this.ctx.secrets.store(STORE, JSON.stringify(s)); return s; }

	private async secret(prompt: boolean): Promise<string> {
		let v = await this.ctx.secrets.get(SECRET);
		if (!v && prompt) {
			v = (await vscode.window.showInputBox({ prompt: "Client Secret of your Roblox OAuth 2.0 app (Creator Dashboard → OAuth 2.0 Apps). Kept in SecretStorage.", password: true, ignoreFocusOut: true }))?.trim();
			if (v) await this.ctx.secrets.store(SECRET, v);
		}
		if (!v) throw new Error("Roblox client secret not set (run Parlay: Sign in to Roblox)");
		return v;
	}
}

const pack = (t: Tok, asked: string[]) => ({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, scopes: t.scope?.split(" ").filter(Boolean) ?? asked });

// A one-shot http server on the first free of PORTS (loopback only: no firewall prompt); opens the browser once it
// listens and resolves with the code Roblox redirects back with, after checking state.
function callback(state: string, token: vscode.CancellationToken, open: (redirectUri: string) => Thenable<boolean>): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		let i = 0;
		const done = (e?: Error, code?: string) => { clearTimeout(t); sub.dispose(); server.close(); e ? reject(e) : resolve({ code: code!, redirectUri: redirect(PORTS[i]) }); };
		const t = setTimeout(() => done(new Error("Roblox sign-in timed out")), 5 * 60_000);
		const sub = token.onCancellationRequested(() => done(new Error("Cancelled")));
		const server = http.createServer((req, res) => {
			const u = new URL(req.url ?? "/", "http://localhost");
			if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
			const err = u.searchParams.get("error"), code = u.searchParams.get("code");
			const ok = !err && !!code && u.searchParams.get("state") === state;
			const text = ok ? "Signed in to Roblox. You can close this tab and go back to Parlay." : `Roblox sign-in failed: ${err ?? "state mismatch"}`;
			res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Parlay</title><body style="font:15px system-ui;padding:3em;text-align:center">${text.replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;")}`);
			done(ok ? undefined : new Error(err ? `Roblox: ${err} ${u.searchParams.get("error_description") ?? ""}`.trim() : "state mismatch on the callback"), code ?? undefined);
		});
		server.on("error", (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE" && i + 1 < PORTS.length ? server.listen(PORTS[++i], "127.0.0.1") : done(e));
		server.on("listening", () => void open(redirect(PORTS[i])));
		server.listen(PORTS[i], "127.0.0.1");
	});
}

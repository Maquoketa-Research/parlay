// Log in with Discord: the same OAuth 2.0 code + PKCE flow as Roblox (oauth.ts), provider id "discord", scope
// identify only, so Parlay knows who you are on Discord (id, username, display name, avatar) and nothing else.
//
// Verified 2026-09-15 against https://docs.discord.com/developers/topics/oauth2 and
// https://docs.discord.com/developers/resources/user :
//   authorize  GET  https://discord.com/oauth2/authorize           state supported ("highly recommend")
//   token      POST https://discord.com/api/oauth2/token           grant_type authorization_code | refresh_token
//   revoke     POST https://discord.com/api/oauth2/token/revoke    token (token_type_hint optional)
//   user       GET  https://discord.com/api/users/@me              id, username, global_name, avatar; email needs the email scope
//   "All calls to the OAuth2 endpoints require either HTTP Basic authentication or client_id and client_secret
//   supplied in the form data body": a confidential client, so the secret sits in SecretStorage (parlay.discordClientSecret).
//   Access tokens live 7 days (expires_in 604800). The docs say nothing about refresh rotation or PKCE; in practice
//   each refresh returns a new refresh_token and the old one answers invalid_grant
//   (https://github.com/discord/discord-api-docs/issues/5942), which oauth.ts covers by storing the new one, and
//   PKCE is accepted though undocumented (https://github.com/discord/discord-api-docs/issues/5254). The redirect
//   is "whatever URL you registered" (Developer Portal → OAuth2 → Redirects), http://localhost URLs included.
// Avatar (https://docs.discord.com/developers/reference#image-formatting): cdn avatars/<id>/<hash>.png when the
// user set one, else the default embed/avatars/<(id >> 22) % 6>.png of the new username system.
import * as vscode from "vscode";
import { OAuthProvider, REDIRECTS, register } from "./oauth";

const API = "https://discord.com/api";
const CDN = "https://cdn.discordapp.com";
const avatar = (id: string, hash: string | null) => hash ? `${CDN}/avatars/${id}/${hash}.png?size=64` : `${CDN}/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`;

export function registerDiscordAuth(ctx: vscode.ExtensionContext): OAuthProvider {
	return register(ctx, {
		id: "discord", label: "Discord",
		authorizeUrl: "https://discord.com/oauth2/authorize", tokenUrl: `${API}/oauth2/token`, userinfoUrl: `${API}/users/@me`, revokeUrl: `${API}/oauth2/token/revoke`,
		scopes: ["identify"],
		dashboardUrl: "https://discord.com/developers/applications",
		setupSteps: "1. Discord Developer Portal → Applications → New Application (any name). On OAuth2, copy the Client ID.\n"
			+ `2. OAuth2 → Redirects: add ${REDIRECTS.join("  and  ")}\n`
			+ "3. OAuth2 → Client Secret → Reset Secret, then copy it; it shows once.\n"
			+ "4. Put the Client ID in the setting parlay.discordClientId, then run Parlay: Sign in to Discord again; it asks for the secret once and keeps it in SecretStorage.",
		parseUser: (me: { id: string; username: string; global_name: string | null; avatar: string | null }) =>
			({ id: me.id, name: me.username, displayName: me.global_name || me.username, avatar: avatar(me.id, me.avatar) }),
	});
}

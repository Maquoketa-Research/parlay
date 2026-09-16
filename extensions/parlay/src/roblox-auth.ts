// Log in with Roblox: the OAuth 2.0 code + PKCE flow in oauth.ts against Roblox's OpenID provider, provider id
// "roblox", so the account sits in the Accounts menu and the rest of Parlay asks
// vscode.authentication.getSession("roblox", SCOPES, ...) the way it would for GitHub.
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
// Scopes: openid and profile are identity scopes; asset:read and asset:write are what the Meshy tab's uploads use
// (https://create.roblox.com/docs/cloud/open-cloud/usage-assets). Nothing else is asked for: the Instance resource
// lists API Key only, no OAuth 2.0 (https://create.roblox.com/docs/cloud/reference/Instance), which is why
// studio.ts keeps its key path.
// Avatar: the public headshot thumbnail (https://thumbnails.roblox.com/v1/users/avatar-headshot, no auth); a
// "Pending" reply has no imageUrl yet, so the account may show without one until the next sign-in.
import * as vscode from "vscode";
import { OAuthProvider, REDIRECTS, register } from "./oauth";

const OAUTH = "https://apis.roblox.com/oauth/v1";
export const SCOPES = ["openid", "profile", "asset:read", "asset:write"];

const avatar = (id: string) => fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=48x48&format=Png`)
	.then((r) => r.json() as Promise<{ data?: { imageUrl?: string }[] }>).then((j) => j.data?.[0]?.imageUrl || undefined, () => undefined);

export function registerRobloxAuth(ctx: vscode.ExtensionContext): OAuthProvider {
	return register(ctx, {
		id: "roblox", label: "Roblox",
		authorizeUrl: `${OAUTH}/authorize`, tokenUrl: `${OAUTH}/token`, userinfoUrl: `${OAUTH}/userinfo`, revokeUrl: `${OAUTH}/token/revoke`,
		scopes: SCOPES,
		dashboardUrl: "https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab",
		setupSteps: "1. Creator Dashboard → Open Cloud → OAuth 2.0 Apps → Create App, on an ID-verified Roblox account (the name must be unique across Roblox). Copy the Client ID and the Client Secret; the secret shows once.\n"
			+ `2. Redirect URLs: ${REDIRECTS.join("  and  ")}\n`
			+ `3. Permissions: ${SCOPES.join(", ")}\n`
			+ "4. Put the Client ID in the setting parlay.robloxClientId, then run Parlay: Sign in to Roblox again; it asks for the secret once and keeps it in SecretStorage.",
		parseUser: async (me: { sub: string; preferred_username: string; name?: string }) =>
			({ id: me.sub, name: me.preferred_username, displayName: me.name || me.preferred_username, avatar: await avatar(me.sub) }),
	});
}

// PKCE (RFC 7636): a random code verifier and its S256 challenge. Its own module with no vscode import so the
// check at the bottom runs as plain Node:   node src/pkce.ts
import assert from "assert";
import { createHash, randomBytes } from "crypto";

export const verifier = () => randomBytes(32).toString("base64url");   // 43 chars, inside the RFC's 43..128
export const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// RFC 7636 appendix B vector
if (process.argv[1]?.endsWith("pkce.ts")) {
	assert.strictEqual(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	assert.match(verifier(), /^[A-Za-z0-9_-]{43}$/);
	console.log("pkce: ok");
}

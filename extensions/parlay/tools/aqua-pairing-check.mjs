import assert from 'node:assert/strict';
import { requestPairing, pairingSecret } from '../src/aquaPairing.ts';
const place = { placeId: '123', universeId: '456', placeName: 'Game', studioUserId: '789' };
const url = 'https://aqua.example';
const original = globalThis.fetch;
let replies, calls;
globalThis.fetch = async (url, options) => {
  calls.push({ url, ...options });
  assert.equal(options.redirect, 'error');
  options.signal.throwIfAborted();
  const next = replies.shift();
  assert.ok(next, 'unexpected request');
  return new Response(JSON.stringify(next.data ?? next), { status: next.http ?? 200 });
};
const start = { id: 'private-request', code: 'ABCDEF', status: 'pending', expires_in: 300 };
const approved = { status: 'approved', key: 'private-token', game: 'My game' };
const run = (responses, signal = new AbortController().signal, onCode = () => {}) => {
  replies = responses; calls = [];
  return requestPairing(url, place, signal, onCode);
};
try {
  let code;
  assert.deepEqual(await run([start, { status: 'pending' }, approved, { place: { known: true } }], undefined, value => code = value), { key: 'private-token', game: 'My game' });
  assert.equal(code, 'ABCDEF');
  assert.deepEqual(JSON.parse(calls[0].body), place);
  assert.equal(calls[0].headers['X-Aqua-Key'], undefined);
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls.at(-1).headers['X-Aqua-Key'], 'private-token');
  assert.equal(calls.at(-1).url, `${url}/api/studio/ping?place_id=123`);
  assert.ok(!calls.some(call => call.url.includes('/approve')));
  await assert.rejects(run([start, { status: 'denied' }]), /declined/);
  await assert.rejects(run([start, { http: 404, data: {} }]), /expired/);
  await assert.rejects(run([start, { status: 'approved', game: 'No key' }]), /credential/);
  await assert.rejects(run([start, approved, { place: { known: false } }]), /different place/);
  await assert.rejects(run([start, approved, { place: { known: true, blocked: 'Live place blocked' } }]), /Live place blocked/);
  const controller = new AbortController();
  await assert.rejects(run([start], controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  await assert.rejects(run([start, { http: 403, data: { detail: 'Access revoked' } }]), /Access revoked/);
  assert.notEqual(pairingSecret(url, place), pairingSecret('https://other.example', place));
  assert.notEqual(pairingSecret(url, place), pairingSecret(url, { ...place, placeId: '9' }));
  assert.notEqual(pairingSecret(url, place), pairingSecret(url, { ...place, studioUserId: '8' }));
  console.log('Aqua pairing: requester handshake, approval validation, cancellation and credential scope passed');
} finally { globalThis.fetch = original; }

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  pulsSessionSecret,
  signPulsDirectToken,
  verifyPulsDirectToken,
  verifySupabaseJwt,
} from '../lib/auth_verify.js';

const payload = () => ({ sub: 'supabase_11111111-2222-3333-4444-555555555555', email: 'user@example.com', user_metadata: { full_name: 'Test User' } });

describe('Puls Direct tokens (HS256)', () => {
  test('roundtrip: signed token verifies and preserves claims', () => {
    const token = signPulsDirectToken(payload());
    const got = verifyPulsDirectToken(token);
    assert.ok(got);
    assert.equal(got.sub, 'supabase_11111111-2222-3333-4444-555555555555');
    assert.equal(got.email, 'user@example.com');
    assert.equal(typeof got.exp, 'number');
    assert.ok(got.exp > Math.floor(Date.now() / 1000));
  });

  test('rejects a forged signature (attacker swaps the payload)', () => {
    const token = signPulsDirectToken(payload());
    const [h] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'supabase_VICTIM', email: 'victim@example.com' })).toString('base64url');
    assert.equal(verifyPulsDirectToken(`${h}.${forged}.${token.split('.')[2]}`), null);
  });

  test('rejects the legacy literal "signed_puls_direct" signature', () => {
    const [h, b] = signPulsDirectToken(payload()).split('.');
    assert.equal(verifyPulsDirectToken(`${h}.${b}.signed_puls_direct`), null);
  });

  test('rejects an expired token', () => {
    const secret = pulsSessionSecret();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'supabase_x', exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    assert.equal(verifyPulsDirectToken(`${header}.${body}.${sig}`), null);
  });

  test('rejects a token signed with a DIFFERENT secret (secret rotation)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'supabase_x', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const badSig = crypto.createHmac('sha256', 'wrong-secret').update(`${header}.${body}`).digest('base64url');
    assert.equal(verifyPulsDirectToken(`${header}.${body}.${badSig}`), null);
  });

  test('rejects garbage / missing parts', () => {
    assert.equal(verifyPulsDirectToken(null), null);
    assert.equal(verifyPulsDirectToken(''), null);
    assert.equal(verifyPulsDirectToken('not-a-jwt'), null);
    assert.equal(verifyPulsDirectToken('a.b'), null);
  });
});

describe('Supabase JWT verification (signature required)', () => {
  test('rejects an unsigned "alg:none" token even with valid-looking claims', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'supabase_VICTIM', email: 'v@x.y', exp: Math.floor(Date.now() / 1000) + 9999 })).toString('base64url');
    const out = await verifySupabaseJwt(`${header}.${body}.`, 'https://example.supabase.co');
    assert.equal(out, null);
  });

  test('rejects a token whose signature is not a valid ES256 over the payload', async () => {
    // Valid ES256-shaped header + arbitrary body; no JWKS/network needed —
    // verification must fail before or at signature checking.
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'nope' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'supabase_VICTIM', email: 'v@x.y', iss: 'https://example.supabase.co/auth/v1', exp: Math.floor(Date.now() / 1000) + 9999 })).toString('base64url');
    const sig = crypto.randomBytes(64).toString('base64url');
    const out = await verifySupabaseJwt(`${header}.${body}.${sig}`, 'https://example.supabase.co');
    assert.equal(out, null);
  });

  test('returns null without crashing on empty inputs', async () => {
    assert.equal(await verifySupabaseJwt(null, 'https://example.supabase.co'), null);
    assert.equal(await verifySupabaseJwt('', ''), null);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 's' })).toString('base64url');
    assert.equal(await verifySupabaseJwt(`${header}.${body}.sig`, ''), null);
  });
});

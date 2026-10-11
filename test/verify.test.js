// 서명 검증 테스트: 임시 키 쌍을 만들어 진짜/가짜 요청을 구분하는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyDiscordSignature } from '../src/bot/verify.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ type: 'spki', format: 'der' });
const publicKeyHex = der.subarray(der.length - 32).toString('hex'); // 끝 32바이트가 실제 공개키

const timestamp = '1700000000';
const body = '{"type":1}';
const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

test('올바른 서명은 통과한다', () => {
  assert.equal(verifyDiscordSignature(body, signature, timestamp, publicKeyHex), true);
});

test('본문이 바뀌면 거절된다', () => {
  assert.equal(verifyDiscordSignature(`${body} `, signature, timestamp, publicKeyHex), false);
});

test('이상한 서명/키 형식은 오류 없이 거절된다', () => {
  assert.equal(verifyDiscordSignature(body, 'zz', timestamp, publicKeyHex), false);
  assert.equal(verifyDiscordSignature(body, signature, timestamp, 'not-a-key'), false);
});
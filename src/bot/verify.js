// 디스코드 요청 서명 검증 (Ed25519). 외부 패키지 없이 Node 내장 crypto만 사용한다.
// 디스코드는 "타임스탬프 + 요청 본문"에 서명해서 보낸다. 공개키로 진짜인지 확인한다.
import { createPublicKey, verify } from 'node:crypto';

// Ed25519 공개키(32바이트)를 Node가 읽을 수 있는 DER 형식으로 감싸는 고정 머리말
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * @param {string} rawBody      가공하지 않은 요청 본문 문자열
 * @param {string} signature    x-signature-ed25519 헤더 (hex)
 * @param {string} timestamp    x-signature-timestamp 헤더
 * @param {string} publicKeyHex 디스코드 개발자 포털의 Public Key (hex)
 * @returns {boolean}
 */
export function verifyDiscordSignature(rawBody, signature, timestamp, publicKeyHex) {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signature, 'hex'));
  } catch {
    return false; // 형식이 이상한 값은 전부 "가짜 요청"으로 처리
  }
}
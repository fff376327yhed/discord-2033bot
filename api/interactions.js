// Vercel 서버리스 함수: 디스코드가 슬래시 커맨드/버튼 클릭을 이 주소로 보내준다.
// 주소: https://<내 도메인>/api/interactions  (디스코드 개발자 포털의 Interactions Endpoint URL)
import { verifyDiscordSignature, handleInteraction, InteractionType, errorReply } from '../src/bundle.js';

// 서명 검증에는 "가공하지 않은 원본 본문"이 필요하므로 자동 JSON 해석을 끈다.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 100_000; // 이보다 큰 요청은 거절

// 원본 본문을 문자열로 읽는다.
async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Vercel 보조 함수(res.json 등)에 의존하지 않고 직접 응답한다.
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 허용됩니다.' });

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return send(res, 413, { error: '요청이 너무 큽니다.' });
  }

  // 1) 진짜 디스코드가 보낸 요청인지 서명 확인 (실패하면 401)
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    console.error('[interactions] DISCORD_PUBLIC_KEY 환경 변수가 없습니다.');
    return send(res, 500, { error: '서버 설정 오류' });
  }
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!signature || !timestamp || !verifyDiscordSignature(raw, String(signature), String(timestamp), publicKey)) {
    return send(res, 401, { error: 'invalid request signature' });
  }

  let interaction;
  try {
    interaction = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: '잘못된 요청입니다.' });
  }

  // 2) 디스코드의 연결 확인(PING)에는 PONG으로 답한다. 엔드포인트 URL 저장 때 필요
  if (interaction.type === InteractionType.PING) return send(res, 200, { type: 1 });

  // 3) 실제 처리. 3초 안에 응답해야 한다.
  try {
    return send(res, 200, await handleInteraction(interaction));
  } catch (err) {
    console.error('[interactions 오류]', err); // 상세 오류는 서버 로그에만 남김
    return send(res, 200, errorReply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'));
  }
}
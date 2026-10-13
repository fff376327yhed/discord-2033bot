// Vercel 서버리스 함수: 디스코드가 슬래시 커맨드/버튼 클릭을 이 주소로 보내준다.
// 주소: https://<내 도메인>/api/interactions  (디스코드 개발자 포털의 Interactions Endpoint URL)
import { verifyDiscordSignature, handleInteraction, InteractionType, errorReply } from '../src/bundle.js';

// 서명 검증에는 "가공하지 않은 원본 본문"이 필요하므로 자동 JSON 해석을 끈다.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 100_000; // 이보다 큰 요청은 거절

// 허용 채널 ID 목록 (환경 변수 ALLOWED_CHANNEL_IDS, 쉼표로 구분). 비어 있으면 모든 채널에서 허용한다.
// 환경 변수 없이 코드에 직접 박고 싶으면 아래처럼 바꾸면 된다: const ALLOWED_CHANNEL_IDS = ['채널ID'];
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 허용된 채널인지 확인. 스레드에서 실행한 경우 부모 채널이 허용되어 있으면 통과시킨다.
function isAllowedChannel(interaction) {
  // 원인 확인용 로그: 문제가 해결되면 이 줄은 지워도 된다.
  console.log('[채널검사]', {
    list: ALLOWED_CHANNEL_IDS,
    channel: interaction.channel_id,
    parent: interaction.channel?.parent_id,
  });
  if (ALLOWED_CHANNEL_IDS.length === 0) return true;
  const ids = [interaction.channel_id, interaction.channel?.id, interaction.channel?.parent_id];
  return ids.some((id) => id && ALLOWED_CHANNEL_IDS.includes(id));
}

// 허용되지 않은 채널에서 쓴 사람에게만 보이는 안내 메시지
function blockedReply(interaction) {
  // 자동완성(type 4)에는 메시지로 답할 수 없어서 빈 목록으로 답한다.
  if (interaction.type === 4) return { type: 8, data: { choices: [] } };
  const mention = ALLOWED_CHANNEL_IDS.map((id) => `<#${id}>`).join(', ');
  return {
    type: 4,
    data: { content: `이 봇은 ${mention} 채널에서만 사용할 수 있어요!`, flags: 64 },
  };
}

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

  // 2-1) 허용되지 않은 채널이면 여기서 막는다. (버튼/자동완성/모달 포함 모든 상호작용)
  if (!isAllowedChannel(interaction)) return send(res, 200, blockedReply(interaction));

  // 3) 실제 처리. 3초 안에 응답해야 한다.
  try {
    return send(res, 200, await handleInteraction(interaction));
  } catch (err) {
    console.error('[interactions 오류]', err); // 상세 오류는 서버 로그에만 남김
    return send(res, 200, errorReply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'));
  }
}
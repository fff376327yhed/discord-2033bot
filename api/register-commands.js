// 슬래시 커맨드를 디스코드에 등록한다. 커맨드 정의를 바꿀 때마다 다시 실행.
// 실행: npm run register
// DISCORD_GUILD_ID가 있으면 테스트 서버에만 즉시 등록, 없으면 전역 등록(반영에 시간이 걸릴 수 있음)
import 'dotenv/config';
import { COMMANDS } from '../src/bot/commands.js';

const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId } = process.env;

if (!appId || !token) {
  console.error('❌ .env에 DISCORD_APPLICATION_ID 와 DISCORD_BOT_TOKEN 을 채워주세요.');
  process.exit(1);
}

const base = `https://discord.com/api/v10/applications/${appId}`;
const url = guildId ? `${base}/guilds/${guildId}/commands` : `${base}/commands`;

const response = await fetch(url, {
  method: 'PUT', // 목록 전체를 이 내용으로 교체 (빠진 커맨드는 삭제됨)
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});

const text = await response.text();
if (!response.ok) {
  console.error(`❌ 등록 실패 (HTTP ${response.status})`);
  console.error(text);
  process.exit(1);
}

const registered = JSON.parse(text);
console.log(`✅ 커맨드 ${registered.length}개 등록 완료 (${guildId ? '테스트 서버 전용' : '전역'})`);
registered.forEach((command) => console.log(`   /${command.name}`));
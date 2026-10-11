// 해정2033 통합 스크립트. scripts/cli.js 로 두고 사용한다.
// 실행: node scripts/cli.js <명령>
//   check     Firestore 연결 테스트 (쓰기/읽기/삭제)
//   dev       로컬 개발 서버 (api/index.js + public)
//   play      터미널에서 샘플 스토리 플레이
//   register  디스코드 슬래시 커맨드 등록
//   seed      샘플 스토리를 Firestore에 업로드

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// check: Firestore 연결 테스트
// ─────────────────────────────────────────────
async function check() {
  const { getDb } = await import('../src/bundle.js');

  const db = getDb();
  const ref = db.collection('_health').doc('check');

  await ref.set({ at: Date.now(), note: '해정2033 연결 테스트' });
  console.log('✅ 쓰기 성공');

  const snap = await ref.get();
  console.log('✅ 읽기 성공:', snap.data());

  await ref.delete();
  console.log('✅ 삭제 성공. Firestore 연결 정상입니다.');
}

// ─────────────────────────────────────────────
// dev: 로컬 개발 서버
// ─────────────────────────────────────────────
async function dev() {
  const { default: express } = await import('express');
  const { default: app } = await import('../api/index.js'); // 이 import 과정에서 .env가 로드됨

  const port = Number(process.env.PORT) || 3000;

  const root = express();
  root.use(express.static(path.resolve(__dirname, '../public'))); // Vercel이 public을 서빙하는 것과 동일하게
  root.use(app);

  root.listen(port, () => {
    console.log(`🚇 해정2033 로컬 서버: http://localhost:${port}`);
    console.log(`   상태 확인: http://localhost:${port}/api/health`);
  });
}

// ─────────────────────────────────────────────
// play: 터미널 플레이
// ─────────────────────────────────────────────
async function play() {
  const { default: readline } = await import('node:readline/promises');
  const { stdin: input, stdout: output } = await import('node:process');
  const { sampleStory } = await import('../src/bundle.js');
  const { validateStory, startStory, advance, getAvailableChoices } = await import('../src/bundle.js');

  const { config } = sampleStory;
  const loadScene = async (id) => sampleStory.scenes[id] ?? null; // 지금은 메모리에서, 3단계에서는 Firestore에서

  // 스탯/자원/파벌/소지품을 한 줄로 보여준다
  const statusLine = (state) => {
    const parts = [];
    for (const bucket of ['stats', 'resources', 'factions']) {
      for (const [key, def] of Object.entries(config[bucket] ?? {})) {
        parts.push(`${def.label} ${state[bucket][key]}`);
      }
    }
    const items = Object.entries(state.inventory).map(([key, n]) => `${config.items?.[key]?.label ?? key}x${n}`);
    return `[${parts.join(' | ')}] 소지품: ${items.length ? items.join(', ') : '없음'}`;
  };

  // 시작 전에 스토리 검증
  const report = validateStory(sampleStory);
  console.log(report.ok ? '✅ 스토리 검증 통과' : '❌ 스토리 검증 실패');
  report.errors.forEach((msg) => console.log('  오류:', msg));
  report.warnings.forEach((msg) => console.log('  경고:', msg));
  if (!report.ok) process.exit(1);

  const rl = readline.createInterface({ input, output });
  let current = await startStory(config, sampleStory.scenes[sampleStory.startSceneId], loadScene);
  if (!current.ok) {
    console.log('시작 실패:', current.message);
    process.exit(1);
  }

  while (true) {
    console.log('\n────────────────────────────');
    if (current.state.station) console.log(`📍 ${current.state.station}`);
    console.log(current.scene.body);
    console.log(statusLine(current.state));

    if (current.state.ending) {
      const { name, type } = current.state.ending;
      console.log(`\n🏁 엔딩 [${type}] ${name}`);
      break;
    }

    const choices = getAvailableChoices(config, current.state, current.scene);
    choices.forEach((c, i) => {
      const lock = c.enabled ? '' : '🔒 ';
      const reason = c.enabled ? '' : ` (${c.lockedReason})`;
      console.log(`  ${i + 1}. ${lock}${c.label}${reason}`);
    });

    const answer = (await rl.question('번호 선택 (q = 종료) > ')).trim();
    if (answer === 'q') break;

    const picked = choices[Number(answer) - 1];
    if (!picked) {
      console.log('올바른 번호를 입력하세요.');
      continue;
    }

    const next = await advance(config, current.state, current.scene, picked.index, loadScene);
    if (!next.ok) {
      console.log(`⚠️ ${next.message}`);
      continue;
    }
    next.changes.forEach((c) => console.log(`   ▸ ${c.label}: ${c.from} → ${c.to}`));
    current = next;
  }

  rl.close();
}

// ─────────────────────────────────────────────
// register: 디스코드 슬래시 커맨드 등록
// DISCORD_GUILD_ID가 있으면 테스트 서버에만 즉시 등록, 없으면 전역 등록
// ─────────────────────────────────────────────
async function register() {
  await import('dotenv/config');
  const { COMMANDS } = await import('../src/bundle.js');

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
}

// ─────────────────────────────────────────────
// seed: 샘플 스토리를 Firestore에 업로드 (여러 번 실행해도 안전, 플레이 수 유지)
// ─────────────────────────────────────────────
async function seed() {
  const { getDb } = await import('../src/bundle.js');
  const { COL } = await import('../src/bundle.js');
  const { sampleStory } = await import('../src/bundle.js');

  const db = getDb();
  const storyRef = db.collection(COL.STORIES).doc(sampleStory.id);
  const existing = await storyRef.get();
  const now = Date.now();

  // 스토리 본체
  await storyRef.set({
    authorId: sampleStory.authorId,
    title: sampleStory.title,
    description: sampleStory.description,
    tags: sampleStory.tags,
    isPublic: true,
    startSceneId: sampleStory.startSceneId,
    config: sampleStory.config,
    likeCount: existing.get('likeCount') ?? 0,
    playCount: existing.get('playCount') ?? 0,
    sceneCount: Object.keys(sampleStory.scenes).length,
    createdAt: existing.get('createdAt') ?? now,
    updatedAt: now,
  });

  // 장면들 (하위 컬렉션). 문서 ID = 장면 키
  const batch = db.batch();
  Object.entries(sampleStory.scenes).forEach(([sceneId, scene], i) => {
    const { id, ...data } = scene; // id는 문서 ID로 대신하므로 필드에서 뺀다
    batch.set(storyRef.collection(COL.SCENES).doc(sceneId), {
      ...data,
      posX: (i % 4) * 260, // 에디터(5단계)에서 쓸 노드 위치 초기값
      posY: Math.floor(i / 4) * 180,
    });
  });
  await batch.commit();

  console.log(`✅ 샘플 스토리 업로드 완료: ${sampleStory.id} (장면 ${Object.keys(sampleStory.scenes).length}개)`);
}

// ─────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────
const COMMANDS_MAP = { check, dev, play, register, seed };
const name = process.argv[2];

if (!COMMANDS_MAP[name]) {
  console.log('사용법: node scripts/cli.js <check | dev | play | register | seed>');
  process.exit(name ? 1 : 0);
}

await COMMANDS_MAP[name]();
// 해정2033 통합 스크립트. scripts/cli.js 로 두고 사용한다.
// 실행: node scripts/cli.js <명령>
//   check     Firestore 연결 테스트 (쓰기/읽기/삭제)
//   dev       로컬 개발 서버 (api/index.js + public)
//   play      터미널에서 샘플 스토리 플레이
//   register  디스코드 슬래시 커맨드 등록
//   seed      샘플 스토리를 Firestore에 업로드
//   cleanup   삭제된 스토리의 남은 기록(세션/엔딩 도감/좋아요)과 만료된 속도제한 카운터 정리 (7-3)
//   reports   처리 전 신고 목록 보기 (7-4)            예) node scripts/cli.js reports
//   resolve   신고 처리 표시 (7-4)                    예) node scripts/cli.js resolve <신고ID> resolved|dismissed
//   hide      스토리 숨기기 (7-4)                     예) node scripts/cli.js hide <스토리ID> [사유]
//   unhide    스토리 숨김 해제 (7-4)                  예) node scripts/cli.js unhide <스토리ID>
//   block     사용자 차단 (7-4, 로그인 끊김)           예) node scripts/cli.js block <디스코드유저ID> [사유]
//   unblock   사용자 차단 해제 (7-4)                  예) node scripts/cli.js unblock <디스코드유저ID>
//   reindex   이미 있는 스토리에 검색 열쇠(titleKey, tagKeys) 채우기 (7-5)   예) node scripts/cli.js reindex [--dry]
//   preflight 배포 전 점검 (7-6)                      예) node scripts/cli.js preflight [--prod] [--file 경로]

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
  const { sampleStory, searchKeys } = await import('../src/bundle.js');

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
    ...searchKeys(sampleStory.title, sampleStory.tags), // 7-5: 검색용 열쇠
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
// cleanup: 삭제된 스토리의 남은 기록 정리 (7-3)
// 서버의 예약 작업(GET /api/cron/cleanup)과 같은 일을 내 PC에서 직접 한다. 여러 번 실행해도 안전하다.
// 내 PC에서는 시간 제한이 느슨해서 55초 동안 일한다.
// ─────────────────────────────────────────────
async function cleanup() {
  const { getDb, runCleanup } = await import('../src/bundle.js');

  const result = await runCleanup(getDb(), { budgetMs: 55_000 });
  console.log(`✅ 정리 끝낸 스토리: ${result.tasksDone}개`);
  console.log(`   아직 남은 스토리: ${result.tasksLeft}개${result.tasksLeft > 0 ? ' (한 번 더 실행하세요)' : ''}`);
  console.log(`   지운 만료 속도제한 카운터: ${result.rateLimitsDeleted}개${result.rateLimitsDone ? '' : ' (더 남았을 수 있음, 한 번 더 실행하세요)'}`);
}

// ─────────────────────────────────────────────
// 7-4 운영 명령: 신고 보기 / 숨김 / 차단
// 웹의 /api/admin/... 과 같은 함수를 쓴다. 내 PC에서 .env의 Firestore 키로 직접 실행하므로 따로 로그인은 필요 없다.
// 주의: 서버(Vercel)의 둘러보기 목록 캐시는 최대 60초 뒤에 반영된다.
// ─────────────────────────────────────────────
const STORY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_RE = /^\d{5,25}$/;
const CLI_ADMIN = 'cli'; // 기록에 남는 "처리한 사람" 이름

async function reports() {
  const { getDb, listReports, MODERATION } = await import('../src/bundle.js');
  const list = await listReports(getDb(), { status: 'open' });
  if (list.length === 0) return console.log('✅ 처리할 신고가 없습니다.');
  console.log(`처리 전 신고 ${list.length}건 (최신순)\n`);
  for (const r of list) {
    console.log(`• 신고ID: ${r.id}`);
    console.log(`  스토리: ${r.storyTitle} (${r.storyId})  작성자: ${r.authorId}`);
    console.log(`  사유: ${MODERATION.REASONS[r.reason] ?? r.reason}  신고자: ${r.userId}  시각: ${new Date(r.createdAt).toLocaleString('ko-KR')}`);
    if (r.detail) console.log(`  설명: ${r.detail}`);
    console.log('');
  }
}

async function resolve() {
  const { getDb, resolveReport } = await import('../src/bundle.js');
  const [, , , reportId, status] = process.argv;
  const result = await resolveReport(getDb(), reportId, status, CLI_ADMIN);
  if (!result.ok) {
    console.error(`❌ 실패(${result.code}). 사용법: node scripts/cli.js resolve <신고ID> resolved|dismissed`);
    process.exit(1);
  }
  console.log(`✅ 신고를 ${status === 'resolved' ? '처리 완료' : '기각'}로 표시했습니다.`);
}

async function setHidden(hidden) {
  const { getDb, setStoryHidden, clearPublicCache, MODERATION } = await import('../src/bundle.js');
  const storyId = process.argv[3];
  const reason = process.argv.slice(4).join(' ').slice(0, MODERATION.NOTE_MAX);
  if (typeof storyId !== 'string' || !STORY_ID_RE.test(storyId)) {
    console.error(`❌ 스토리 ID가 필요합니다. 사용법: node scripts/cli.js ${hidden ? 'hide' : 'unhide'} <스토리ID>${hidden ? ' [사유]' : ''}`);
    process.exit(1);
  }
  const result = await setStoryHidden(getDb(), storyId, hidden, { adminId: CLI_ADMIN, reason });
  if (!result.ok) {
    console.error('❌ 스토리를 찾을 수 없습니다.');
    process.exit(1);
  }
  clearPublicCache();
  console.log(hidden ? `🙈 숨겼습니다: ${storyId}` : `👀 숨김을 해제했습니다: ${storyId}`);
}

async function setBlocked(blocked) {
  const { createFirestoreSessionStore, MODERATION } = await import('../src/bundle.js');
  const userId = process.argv[3];
  const reason = process.argv.slice(4).join(' ').slice(0, MODERATION.NOTE_MAX);
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    console.error(`❌ 디스코드 유저 ID(숫자)가 필요합니다. 사용법: node scripts/cli.js ${blocked ? 'block' : 'unblock'} <유저ID>${blocked ? ' [사유]' : ''}`);
    process.exit(1);
  }
  await createFirestoreSessionStore().setBlocked(userId, blocked, { reason });
  console.log(blocked ? `⛔ 차단했습니다(로그인이 끊기고 다시 로그인할 수 없습니다): ${userId}` : `✅ 차단을 해제했습니다: ${userId}`);
}

// ─────────────────────────────────────────────
// reindex: 검색 열쇠 채우기 (7-5)
// ─────────────────────────────────────────────
async function reindex() {
  const { getDb, reindexSearchKeys } = await import('../src/bundle.js');
  const dryRun = process.argv.includes('--dry');
  const { total, updated } = await reindexSearchKeys(getDb(), { dryRun });
  console.log(dryRun ? `🔎 (연습) 전체 ${total}개 중 ${updated}개를 고쳐야 합니다. 실제로 고치려면 --dry 를 빼고 다시 실행하세요.` : `✅ 전체 ${total}개 중 ${updated}개에 검색 열쇠를 채웠습니다.`);
}

// ─────────────────────────────────────────────
// preflight: 배포 전 점검 (7-6)
//   기본: 내 PC의 .env 를 점검 (개발용 값이라 일부는 경고가 정상)
//   --file <경로>: 그 파일의 값을 점검 (예: vercel env pull 로 받은 운영 값)
//   --prod: 운영 기준(https, localhost 금지, CRON_SECRET 필수)으로 엄격하게 점검
// ─────────────────────────────────────────────
async function preflight() {
  const fs = await import('node:fs');
  const { default: dotenv } = await import('dotenv');
  const { checkDeployment } = await import('../src/bundle.js'); // 이 import 에서 .env 가 process.env 로 로드됨

  const args = process.argv.slice(3);
  const isProduction = args.includes('--prod');
  const fileIndex = args.indexOf('--file');
  let env = process.env;
  if (fileIndex >= 0) {
    const file = args[fileIndex + 1];
    if (!file || !fs.existsSync(file)) {
      console.error('❌ --file 뒤에 실제 파일 경로를 적어 주세요. 예) --file .env.production.local');
      process.exit(1);
    }
    env = dotenv.parse(fs.readFileSync(file)); // 파일 안의 값만 점검한다 (process.env 와 섞지 않는다)
  }

  let vercelJson = null;
  try {
    vercelJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf8'));
  } catch {
    vercelJson = null;
  }

  const results = checkDeployment({ env, vercelJson, isProduction });
  const icon = { ok: '✅', warn: '⚠️ ', error: '❌' };
  for (const r of results) console.log(`${icon[r.level]} ${r.name}: ${r.message}`);

  const errors = results.filter((r) => r.level === 'error').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n결과: 오류 ${errors}개, 경고 ${warns}개 (${isProduction ? '운영 기준' : '개발 기준'})`);
  if (errors > 0) process.exit(1);
}

const hide = () => setHidden(true);
const unhide = () => setHidden(false);
const block = () => setBlocked(true);
const unblock = () => setBlocked(false);

// ─────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────
const COMMANDS_MAP = { check, dev, play, register, seed, cleanup, reports, resolve, hide, unhide, block, unblock, reindex, preflight };
const name = process.argv[2];

if (!COMMANDS_MAP[name]) {
  console.log('사용법: node scripts/cli.js <check | dev | play | register | seed | cleanup | reports | resolve | hide | unhide | block | unblock | reindex | preflight>');
  process.exit(name ? 1 : 0);
}

await COMMANDS_MAP[name]();
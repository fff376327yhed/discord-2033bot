// 통합 테스트 (엔진 + 메시지 만들기 + 서명 검증 + 4단계 웹 API). 실행: npm test
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac } from 'node:crypto';
import express from 'express';
import {
  sampleStory,
  createInitialState,
  startStory,
  advance,
  applyEffects,
  getAvailableChoices,
  validateStory,
  sceneMessage,
  verifyDiscordSignature,
  signJwt,
  verifyJwt,
  parseCookies,
  sanitizeConfig,
  sanitizeScenes,
  sanitizeMeta,
  createWebRouter,
  createMemorySessionStore,
  createMemoryRateLimitBackend,
  createRateLimitStore,
  isTokenRevoked,
  filterPublicStories,
  WEB,
  COL,
  CLEANUP,
  MODERATION,
  getAdminIds,
  isAdminId,
  isHiddenFrom,
  reportStory,
  setStoryHidden,
  listReports,
  resolveReport,
  deleteByStoryId,
  cleanupStoryRecords,
  deleteExpiredRateLimits,
  runCleanup,
  isCronAuthorized,
  BROWSE,
  searchKeys,
  planPublicSearch,
  buildSliceQuery,
  loadPublicSlice,
  mergePublicStories,
  reindexSearchKeys,
  clearPublicCache,
  REQUEST_LIMITS,
  sizeToBytes,
  checkDeployment,
  reply,
  privateReply,
  errorReply,
  handleInteraction,
  InteractionType,
  getAllowedChannelIds,
  isChannelAllowed,
  getMessageOwnerId,
} from '../src/bundle.js';

const { config } = sampleStory;
const story = { id: sampleStory.id, title: sampleStory.title };
const loadScene = async (id) => sampleStory.scenes[id] ?? null;

// 시작 장면에 진입한 상태를 만든다
async function begin() {
  const result = await startStory(config, sampleStory.scenes[sampleStory.startSceneId], loadScene);
  assert.ok(result.ok, '시작 실패');
  return result;
}

// 선택지 번호를 순서대로 눌러 진행한다
async function play(path) {
  let current = await begin();
  for (const index of path) {
    current = await advance(config, current.state, current.scene, index, loadScene);
    assert.ok(current.ok, `진행 실패: ${current.code}`);
  }
  return current;
}

// ═════════════════════════════════════════════
// 엔진
// ═════════════════════════════════════════════
describe('엔진', () => {
  test('샘플 스토리는 검증을 통과하고 경고도 없다', () => {
    const report = validateStory(sampleStory);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
  });

  test('시작 상태는 config의 초기값을 따른다', async () => {
    const { state } = await begin();
    assert.equal(state.sceneId, 'start');
    assert.equal(state.stats.hp, 100);
    assert.equal(state.resources.food, 2);
    assert.equal(state.station, '군자역');
    assert.equal(state.ending, null);
  });

  test('방독면이 없으면 해당 선택지가 잠기고 진행도 거절된다', async () => {
    const current = await play([1]); // 통조림만 챙김 → tunnel
    const choices = getAvailableChoices(config, current.state, current.scene);
    assert.equal(choices[0].enabled, false);
    assert.equal(choices[0].lockedReason, '방독면 필요');

    const result = await advance(config, current.state, current.scene, 0, loadScene);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOCKED');
  });

  test('효과는 최대/최소 범위로 보정된다', () => {
    const state = createInitialState(config);
    const up = applyEffects(config, state, [{ type: 'resource', key: 'food', delta: 500 }]);
    assert.equal(up.state.resources.food, 99);
    const down = applyEffects(config, state, [{ type: 'stat', key: 'hp', delta: -999 }]);
    assert.equal(down.state.stats.hp, 0);
  });

  test('위험한 키와 정의되지 않은 값은 무시된다', () => {
    const state = createInitialState(config);
    const { state: next } = applyEffects(config, state, [
      { type: 'flag', key: '__proto__', value: true },
      { type: 'stat', key: 'unknown', delta: 5 },
      { type: 'item', key: 'unknown_item', delta: 1 },
    ]);
    assert.deepEqual(next.flags, {});
    assert.deepEqual(next.inventory, {});
    assert.equal(Object.hasOwn(next.stats, 'unknown'), false);
  });

  test('오래된 버튼(다른 장면의 선택지)은 거절된다', async () => {
    const atTunnel = await play([0]); // start → tunnel
    const atStart = await begin();
    // 상태는 tunnel인데 start 장면의 버튼을 누른 상황
    const result = await advance(config, atTunnel.state, atStart.scene, 0, loadScene);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SCENE_MISMATCH');
  });

  test('진행해도 원본 상태는 바뀌지 않는다', async () => {
    const current = await begin();
    const snapshot = structuredClone(current.state);
    await advance(config, current.state, current.scene, 1, loadScene);
    assert.deepEqual(current.state, snapshot);
  });

  test('플래그 조건: 거래는 한 번만 가능하다', async () => {
    // start(방독면) → tunnel(시장) → market(거래)
    const current = await play([0, 2, 0]);
    assert.equal(current.state.flags.traded, true);
    assert.equal(current.state.resources.food, 1);
    assert.equal(current.state.factions.hanse, 10);
    const choices = getAvailableChoices(config, current.state, current.scene);
    assert.equal(choices[0].enabled, false); // 거래 선택지 잠김
  });

  test('체력이 0이 되면 사망 엔딩으로 자동 이동한다', async () => {
    // 맨얼굴로 터널을 두 번 진입: 100 → 20 → 0
    const current = await play([1, 1, 0, 2, 1]);
    assert.equal(current.scene.id, 'ending_dead');
    assert.equal(current.state.ending.name, '독안개 속에서');
    assert.equal(current.state.ending.type, 'bad');
  });

  test('굿 엔딩: 시장에서 거래해 호감도를 쌓고 호위와 함께 탈출', async () => {
    const current = await play([0, 2, 0, 2, 0, 1, 1]);
    assert.equal(current.state.ending.type, 'good');
    assert.equal(current.ending.name, '새벽의 호위');
  });

  test('히든 엔딩: 사무실에서 카드키를 얻어 보안 문을 연다', async () => {
    const current = await play([0, 0, 0, 0, 0]);
    assert.equal(current.state.ending.type, 'hidden');
    assert.equal(current.state.inventory.keycard, 1);
  });

  test('엔딩 이후에는 더 진행할 수 없다', async () => {
    const ended = await play([0, 0, 1, 2]); // start → tunnel → tunnel_safe → exit → ending_bad
    assert.equal(ended.state.ending.type, 'bad');
    const result = await advance(config, ended.state, ended.scene, 0, loadScene);
    assert.equal(result.code, 'ALREADY_ENDED');
  });

  test('검증기가 끊긴 분기와 막다른 길을 찾아낸다', () => {
    const broken = structuredClone(sampleStory);
    broken.scenes.start.choices[0].to = 'nowhere';
    broken.scenes.office.choices = [];
    const report = validateStory(broken);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((msg) => msg.includes('끊긴 분기')));
    assert.ok(report.errors.some((msg) => msg.includes('막다른 길')));
  });
});

// ═════════════════════════════════════════════
// 메시지 만들기: 디스코드 제한(글자수, 버튼 수 등)을 지키는지 확인
// ═════════════════════════════════════════════
describe('메시지 만들기', () => {
  test('시작 장면: 선택지 버튼 2개, custom_id는 규칙과 100자 제한을 지킨다', async () => {
    const { state, scene } = await play([]);
    const message = sceneMessage({ story, scene, state, config });
    const buttons = message.components[0].components;
    assert.equal(buttons.length, 2);
    for (const [i, button] of buttons.entries()) {
      assert.ok(button.custom_id.length <= 100);
      assert.equal(button.custom_id, `c:sample-001:0:${i}`);
    }
  });

  test('조건 미달 선택지는 비활성화되고 🔒 표시와 사유가 나온다', async () => {
    const { state, scene } = await play([1]); // 방독면 없이 터널 도착
    const message = sceneMessage({ story, scene, state, config });
    const first = message.components[0].components[0];
    assert.equal(first.disabled, true);
    assert.ok(first.label.startsWith('🔒'));
    const lockedField = message.embeds[0].fields.find((field) => field.name === '잠김');
    assert.ok(lockedField.value.includes('방독면 필요'));
  });

  test('엔딩 메시지는 버튼이 없고 엔딩 이름이 제목에 나온다', async () => {
    const { state, scene } = await play([0, 0, 0, 0, 0]); // 히든 엔딩
    const message = sceneMessage({ story, scene, state, config });
    assert.deepEqual(message.components, []);
    assert.ok(message.embeds[0].title.includes('지상의 빛'));
  });

  test('너무 긴 본문은 임베드 제한(4096자) 안으로 잘린다', async () => {
    const { state, scene } = await play([]);
    const longScene = { ...scene, body: 'ㄱ'.repeat(10000) };
    const message = sceneMessage({ story, scene: longScene, state, config });
    assert.ok(message.embeds[0].description.length <= 4096);
  });

  test('https가 아닌 이미지 주소는 임베드에 넣지 않는다', async () => {
    const { state, scene } = await play([]);
    const bad = sceneMessage({ story, scene: { ...scene, imageUrl: 'javascript:alert(1)' }, state, config });
    assert.equal(bad.embeds[0].image, undefined);
    const good = sceneMessage({ story, scene: { ...scene, imageUrl: 'https://example.com/a.png' }, state, config });
    assert.equal(good.embeds[0].image.url, 'https://example.com/a.png');
  });
});

// ═════════════════════════════════════════════
// 서명 검증: 임시 키 쌍으로 진짜/가짜 요청을 구분하는지 확인
// ═════════════════════════════════════════════
describe('서명 검증', () => {
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
});

// ═════════════════════════════════════════════
// 4단계: 웹 API (Firestore에 접속하지 않는다)
// ═════════════════════════════════════════════

// 테스트용 환경 변수 (.env 값보다 우선)
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.DISCORD_APPLICATION_ID = '111111111111111111';
process.env.DISCORD_CLIENT_SECRET = 'dummy-client-secret';
process.env.SITE_URL = 'http://localhost:3000';

const USER_ID = '222222222222222222';

// 샘플 스토리 장면에서 id 필드를 뺀 "저장 형식" (Firestore에는 id를 넣지 않는다)
const sampleScenesInput = () => {
  const scenes = structuredClone(sampleStory.scenes);
  for (const scene of Object.values(scenes)) delete scene.id;
  return scenes;
};

// ═════════════════════════════════════════════
// JWT / 쿠키
// ═════════════════════════════════════════════
describe('JWT', () => {
  test('만든 토큰은 검증을 통과하고 내용이 그대로 나온다', () => {
    const payload = verifyJwt(signJwt({ sub: USER_ID, name: '테스터' }));
    assert.equal(payload.sub, USER_ID);
    assert.equal(payload.name, '테스터');
  });

  test('내용을 바꾸면(위조) 거절된다', () => {
    const [h, , s] = signJwt({ sub: USER_ID }).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '999999999999999999', exp: 9999999999 })).toString('base64url');
    assert.equal(verifyJwt(`${h}.${forged}.${s}`), null);
  });

  test('만료된 토큰은 거절된다', () => {
    const token = signJwt({ sub: USER_ID }, 60, Date.now() - 120_000); // 2분 전에 1분짜리로 발급
    assert.equal(verifyJwt(token), null);
  });

  test('alg:none 토큰과 이상한 형식은 거절된다', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: USER_ID, exp: 9999999999 })).toString('base64url');
    assert.equal(verifyJwt(`${header}.${body}.`), null);
    assert.equal(verifyJwt('abc'), null);
    assert.equal(verifyJwt(undefined), null);
    assert.equal(verifyJwt('a.b.c'), null);
  });

  test('다른 비밀 값으로 서명한 토큰은 거절된다', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: USER_ID, exp: 9999999999 })).toString('base64url');
    const sig = createHmac('sha256', 'another-secret-another-secret-123456').update(`${header}.${body}`).digest('base64url');
    assert.equal(verifyJwt(`${header}.${body}.${sig}`), null);
  });

  test('JWT_SECRET이 짧으면 서명 자체를 거부한다', () => {
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'short';
    assert.throws(() => signJwt({ sub: USER_ID }), /JWT_SECRET/);
    process.env.JWT_SECRET = original;
  });
});

describe('쿠키 해석', () => {
  test('여러 쿠키를 읽고, 같은 이름은 첫 번째만 쓴다', () => {
    const cookies = parseCookies('a=1; b=%ED%95%9C; a=2');
    assert.equal(cookies.a, '1');
    assert.equal(cookies.b, '한');
  });

  test('__proto__ 같은 이름이 와도 안전하다', () => {
    const cookies = parseCookies('__proto__=evil; x=1');
    assert.equal(Object.getPrototypeOf(cookies), null);
    assert.equal({}.evil, undefined);
  });

  test('헤더가 없거나 이상해도 빈 객체', () => {
    assert.deepEqual({ ...parseCookies(undefined) }, {});
    assert.deepEqual({ ...parseCookies('이상한값') }, {});
  });
});

// ═════════════════════════════════════════════
// 입력 검증
// ═════════════════════════════════════════════
describe('입력 검증: 장면', () => {
  test('샘플 스토리의 config와 장면은 오류 없이 통과하고 validateStory도 통과한다', () => {
    const errors = [];
    const config = sanitizeConfig(sampleStory.config, errors);
    const scenes = sanitizeScenes(sampleScenesInput(), errors);
    assert.deepEqual(errors, []);

    const withIds = Object.fromEntries(Object.entries(scenes).map(([k, v]) => [k, { ...v, id: k }]));
    const report = validateStory({ startSceneId: 'start', config, scenes: withIds });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
  });

  test('알 수 없는 필드는 버려진다', () => {
    const errors = [];
    const scenes = sanitizeScenes({ a: { body: 'x', hack: '<script>', choices: [] } }, errors);
    assert.equal(scenes.a.hack, undefined);
  });

  test('http/javascript 이미지 주소는 거절된다 (https만 허용)', () => {
    for (const imageUrl of ['http://example.com/a.png', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@example.com/a.png']) {
      const errors = [];
      sanitizeScenes({ a: { body: 'x', imageUrl } }, errors);
      assert.ok(errors.some((msg) => msg.includes('imageUrl')), imageUrl);
    }
    const errors = [];
    const ok = sanitizeScenes({ a: { body: 'x', imageUrl: 'https://example.com/a.png' } }, errors);
    assert.deepEqual(errors, []);
    assert.equal(ok.a.imageUrl, 'https://example.com/a.png');
  });

  test('장면 키 형식, 위험한 키(__proto__)는 거절된다', () => {
    const errors = [];
    sanitizeScenes({ 'bad key': { body: 'x' } }, errors);
    assert.ok(errors.length > 0);

    const polluted = JSON.parse('{"__proto__": {"body": "x"}, "ok": {"body": "y"}}'); // 자기 속성으로 __proto__ 가 생김
    const errors2 = [];
    const out = sanitizeScenes(polluted, errors2);
    assert.ok(errors2.length > 0);
    assert.equal(Object.hasOwn(out, '__proto__'), false);
    assert.equal({}.body, undefined);
  });

  test('길이 제한: 본문, 버튼 문구, 선택지 개수, 장면 개수', () => {
    let errors = [];
    sanitizeScenes({ a: { body: 'ㄱ'.repeat(1801) } }, errors);
    assert.ok(errors.some((msg) => msg.includes('body')));

    errors = [];
    sanitizeScenes({ a: { body: 'x', choices: [{ label: 'ㄱ'.repeat(81), to: 'a' }] } }, errors);
    assert.ok(errors.some((msg) => msg.includes('label')));

    errors = [];
    const six = Array.from({ length: 6 }, () => ({ label: '선택', to: 'a' }));
    sanitizeScenes({ a: { body: 'x', choices: six } }, errors);
    assert.ok(errors.some((msg) => msg.includes('최대 5개')));

    errors = [];
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`s${i}`, { body: 'x' }]));
    sanitizeScenes(many, errors);
    assert.ok(errors.some((msg) => msg.includes('최대 200개')));
  });

  test('조건/효과 형식 검사: 알 수 없는 종류, 잘못된 연산자, 숫자가 아닌 값', () => {
    const bad = (choice) => {
      const errors = [];
      sanitizeScenes({ a: { body: 'x', choices: [{ label: '선택', to: 'a', ...choice }] } }, errors);
      return errors;
    };
    assert.ok(bad({ condition: [{ type: 'magic', key: 'x' }] }).length > 0);
    assert.ok(bad({ condition: [{ type: 'stat', key: 'hp', op: '=>', value: 1 }] }).length > 0);
    assert.ok(bad({ condition: [{ type: 'stat', key: 'hp', op: '>=', value: '10' }] }).length > 0);
    assert.ok(bad({ effects: [{ type: 'stat', key: 'hp', delta: 1.5 }] }).length > 0);
    assert.ok(bad({ effects: [{ type: 'flag', key: 'f', value: 'yes' }] }).length > 0);
    assert.ok(bad({ effects: [{ type: 'stat', key: '__proto__', delta: 1 }] }).length > 0);
    assert.deepEqual(bad({ condition: [{ type: 'item', key: 'gasmask' }], effects: [{ type: 'flag', key: 'f' }] }), []);
  });

  test('엔딩 장면은 선택지가 비워지고, 엔딩 종류는 good/bad/hidden만 가능', () => {
    const errors = [];
    const scenes = sanitizeScenes(
      { end: { body: 'x', isEnding: true, endingName: '끝', endingType: 'good', choices: [{ label: '무시됨', to: 'end' }] } },
      errors
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(scenes.end.choices, []);

    const errors2 = [];
    sanitizeScenes({ end: { body: 'x', isEnding: true, endingType: 'weird' } }, errors2);
    assert.ok(errors2.some((msg) => msg.includes('endingType')));
  });

  test('제어문자와 글자 방향 조작 문자는 제거된다', () => {
    const errors = [];
    const scenes = sanitizeScenes({ a: { body: 'a\u0000b‮c', station: '역‏' } }, errors);
    assert.equal(scenes.a.body, 'abc');
    assert.equal(scenes.a.station, '역');
  });
});

describe('입력 검증: config / 메타', () => {
  test('범위가 뒤집히거나 초기값이 범위 밖이면 오류', () => {
    let errors = [];
    sanitizeConfig({ stats: { hp: { label: '체력', initial: 50, min: 100, max: 0 } } }, errors);
    assert.ok(errors.length > 0);

    errors = [];
    sanitizeConfig({ stats: { hp: { label: '체력', initial: 500, min: 0, max: 100 } } }, errors);
    assert.ok(errors.some((msg) => msg.includes('initial')));
  });

  test('시작 소지품은 정의된 아이템만 가능', () => {
    const errors = [];
    sanitizeConfig({ items: { key: { label: '열쇠' } }, startInventory: { key: 1, ghost: 1 } }, errors);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('ghost'));
  });

  test('제목은 필수, 태그는 5개/20자 제한과 중복 제거', () => {
    let errors = [];
    sanitizeMeta({ title: '   ' }, errors);
    assert.ok(errors.some((msg) => msg.includes('title')));

    errors = [];
    const meta = sanitizeMeta({ title: '제목', tags: ['생존', '생존', 'Metro', 'metro'] }, errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(meta.tags, ['생존', 'Metro']);

    errors = [];
    sanitizeMeta({ title: '제목', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, errors);
    assert.ok(errors.some((msg) => msg.includes('최대 5개')));

    errors = [];
    sanitizeMeta({ title: '제목', tags: ['ㄱ'.repeat(21)] }, errors);
    assert.ok(errors.some((msg) => msg.includes('20자')));
  });

  test('수정(partial)은 보낸 필드만 결과에 들어간다', () => {
    const errors = [];
    const meta = sanitizeMeta({ title: '새 제목' }, errors, { partial: true });
    assert.deepEqual(Object.keys(meta), ['title']);
  });
});

// ═════════════════════════════════════════════
// HTTP 흐름 (Firestore 없이 확인 가능한 부분만)
// ═════════════════════════════════════════════
describe('로그인과 권한 (HTTP)', () => {
  let server;
  let base;

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(createWebRouter({ sessionStore: createMemorySessionStore(), rateLimitBackend: createMemoryRateLimitBackend() })); // Firestore 대신 메모리
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const loginCookie = () => `${WEB.SESSION_COOKIE}=${signJwt({ sub: USER_ID, name: '테스터', avatar: null })}`;
  const writeHeaders = (cookie) => ({
    'Content-Type': 'application/json',
    [WEB.CSRF_HEADER]: WEB.CSRF_VALUE,
    ...(cookie ? { Cookie: cookie } : {}),
  });

  test('/api/auth/login: 디스코드로 보내고, state 쿠키는 httpOnly + SameSite=Lax', async () => {
    const res = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);

    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin + location.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(location.searchParams.get('client_id'), process.env.DISCORD_APPLICATION_ID);
    assert.equal(location.searchParams.get('scope'), 'identify');
    assert.equal(location.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/callback');

    const setCookie = res.headers.getSetCookie().join('\n');
    assert.ok(setCookie.includes(`${WEB.STATE_COOKIE}=${location.searchParams.get('state')}`));
    assert.ok(/HttpOnly/i.test(setCookie));
    assert.ok(/SameSite=Lax/i.test(setCookie));
  });

  test('/api/auth/callback: state가 맞지 않으면 실패로 돌려보낸다 (CSRF 방어)', async () => {
    const noCookie = await fetch(`${base}/api/auth/callback?code=abc&state=xyz`, { redirect: 'manual' });
    assert.equal(noCookie.status, 302);
    assert.equal(noCookie.headers.get('location'), '/?login=failed');

    const mismatch = await fetch(`${base}/api/auth/callback?code=abc&state=xyz`, {
      redirect: 'manual',
      headers: { Cookie: `${WEB.STATE_COOKIE}=other` },
    });
    assert.equal(mismatch.headers.get('location'), '/?login=failed');
  });

  test('/api/auth/me: 쿠키가 올바르면 유저, 없거나 위조면 null', async () => {
    const ok = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: loginCookie() } })).json();
    assert.equal(ok.user.id, USER_ID);
    assert.equal(ok.user.username, '테스터');

    const none = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(none.user, null);

    const forged = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: `${WEB.SESSION_COOKIE}=a.b.c` } })).json();
    assert.equal(forged.user, null);
  });

  test('쓰기 요청: 보안 헤더가 없으면 403, 로그인이 없으면 401', async () => {
    const noHeader = await fetch(`${base}/api/stories`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(noHeader.status, 403);

    const noLogin = await fetch(`${base}/api/stories`, { method: 'POST', body: '{}', headers: writeHeaders() });
    assert.equal(noLogin.status, 401);

    const mine = await fetch(`${base}/api/stories/mine`);
    assert.equal(mine.status, 401);

    const del = await fetch(`${base}/api/stories/abc`, { method: 'DELETE', headers: writeHeaders() });
    assert.equal(del.status, 401);
  });

  test('올바르지 않은 스토리 ID는 DB를 보기 전에 400', async () => {
    const res = await fetch(`${base}/api/stories/bad%20id/scenes`, {
      method: 'PUT',
      headers: writeHeaders(loginCookie()),
      body: JSON.stringify({ scenes: {} }),
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/validate: 정상 스토리는 통과, 잘못된 입력은 400', async () => {
    const good = await fetch(`${base}/api/validate`, {
      method: 'POST',
      headers: writeHeaders(loginCookie()),
      body: JSON.stringify({ startSceneId: 'start', config: sampleStory.config, scenes: sampleScenesInput() }),
    });
    assert.equal(good.status, 200);
    const report = await good.json();
    assert.equal(report.ok, true);

    const bad = await fetch(`${base}/api/validate`, {
      method: 'POST',
      headers: writeHeaders(loginCookie()),
      body: JSON.stringify({ startSceneId: 'start', config: {}, scenes: { start: { body: 'x', imageUrl: 'http://evil.example/a.png' } } }),
    });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).details.some((msg) => msg.includes('imageUrl')));
  });
  test('좋아요: 보안 헤더 없으면 403, 로그인 없으면 401, liked가 불리언이 아니면 DB 전에 400', async () => {
    const url = `${base}/api/stories/abc/like`;
    const noHeader = await fetch(url, { method: 'PUT', body: '{"liked":true}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(noHeader.status, 403);

    const noLogin = await fetch(url, { method: 'PUT', body: '{"liked":true}', headers: writeHeaders() });
    assert.equal(noLogin.status, 401);

    const badBody = await fetch(url, { method: 'PUT', body: '{"liked":"yes"}', headers: writeHeaders(loginCookie()) });
    assert.equal(badBody.status, 400);

    const badId = await fetch(`${base}/api/stories/bad%20id/like`, { method: 'PUT', body: '{"liked":true}', headers: writeHeaders(loginCookie()) });
    assert.equal(badId.status, 400);
  });

  test('엔딩 도감 API는 로그인이 필요하다', async () => {
    assert.equal((await fetch(`${base}/api/stories/abc/endings`)).status, 401);
    assert.equal((await fetch(`${base}/api/me/endings`)).status, 401);
  });
});

// ═════════════════════════════════════════════
// 6단계: 둘러보기 검색/정렬 (DB 없이 순수 함수만 확인)
// ═════════════════════════════════════════════
describe('둘러보기: 검색/정렬', () => {
  const mk = (id, extra) => ({ id, title: id, description: '', tags: [], likeCount: 0, playCount: 0, createdAt: 0, ...extra });
  const all = [
    mk('지하철 생존기', { tags: ['생존', 'Metro'], likeCount: 1, playCount: 50, createdAt: 3 }),
    mk('시장 이야기', { description: '한자 동맹 상인', tags: ['시장'], likeCount: 5, playCount: 10, createdAt: 2 }),
    mk('레드라인', { tags: ['생존'], likeCount: 5, playCount: 20, createdAt: 1 }),
  ];

  test('검색어는 제목/설명/태그에서 대소문자 구분 없이 찾는다', () => {
    assert.equal(filterPublicStories(all, { q: '생존기' }).total, 1);
    assert.equal(filterPublicStories(all, { q: '한자' }).stories[0].id, '시장 이야기');
    assert.equal(filterPublicStories(all, { q: 'metro' }).stories[0].id, '지하철 생존기');
    assert.equal(filterPublicStories(all, { q: '없는말' }).total, 0);
  });

  test('태그 필터는 정확히 일치하는 태그만 통과시킨다', () => {
    assert.equal(filterPublicStories(all, { tag: '생존' }).total, 2);
    assert.equal(filterPublicStories(all, { tag: '생' }).total, 0);
  });

  test('인기순: 좋아요 → 플레이 수 순, 최신순은 입력 순서 유지', () => {
    const popular = filterPublicStories(all, { sort: 'popular' }).stories.map((s) => s.id);
    assert.deepEqual(popular, ['레드라인', '시장 이야기', '지하철 생존기']);
    const latest = filterPublicStories(all, { sort: 'latest' }).stories.map((s) => s.id);
    assert.deepEqual(latest, ['지하철 생존기', '시장 이야기', '레드라인']);
  });

  test('페이지 자르기와 전체 개수, 태그 집계', () => {
    const page = filterPublicStories(all, { offset: 1, limit: 1 });
    assert.equal(page.stories.length, 1);
    assert.equal(page.total, 3);
    assert.equal(page.tags[0].tag, '생존');
    assert.equal(page.tags[0].count, 2);
  });
});

// ═════════════════════════════════════════════
// 7단계: 로그아웃 토큰 무효화
// ═════════════════════════════════════════════
describe('로그아웃 토큰 무효화', () => {
  const OTHER_ID = '333333333333333333'; // 다른 테스트의 로그인에 영향을 주지 않도록 별도 사용자
  const startServer = async (sessionStore) => {
    const app = express();
    app.use(express.json());
    app.use(createWebRouter({ sessionStore, rateLimitBackend: createMemoryRateLimitBackend() }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const cookieAt = (now) => `${WEB.SESSION_COOKIE}=${signJwt({ sub: OTHER_ID, name: '로그아웃테스트', avatar: null }, undefined, now)}`;
  const headers = (cookie) => ({ 'Content-Type': 'application/json', [WEB.CSRF_HEADER]: WEB.CSRF_VALUE, ...(cookie ? { Cookie: cookie } : {}) });
  const meOf = async (base, cookie) => (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user;

  test('isTokenRevoked: 기록이 없으면 통과, 같은 초/이전 발급은 무효, 이후 발급은 통과', () => {
    const at = 1_700_000_000_500; // 발급 초 = 1700000000
    assert.equal(isTokenRevoked({ iat: 1_700_000_000 }, 0), false);
    assert.equal(isTokenRevoked({ iat: 1_699_999_999 }, at), true);
    assert.equal(isTokenRevoked({ iat: 1_700_000_000 }, at), true); // 같은 초
    assert.equal(isTokenRevoked({ iat: 1_700_000_001 }, at), false);
    assert.equal(isTokenRevoked({}, at), true); // iat 없는 토큰은 무효
  });

  test('로그아웃하면 같은 토큰이 바로 쓸 수 없게 되고, 이후에 새로 발급된 토큰은 쓸 수 있다', async () => {
    const { server, base } = await startServer(createMemorySessionStore());
    try {
      const old = cookieAt(Date.now());
      assert.equal((await meOf(base, old))?.id, OTHER_ID); // 로그아웃 전에는 정상

      const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: headers(old) });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, revoked: true });
      assert.equal(await meOf(base, old), null); // 같은 토큰 → 무효

      assert.equal((await meOf(base, cookieAt(Date.now() + 3000)))?.id, OTHER_ID); // 다시 로그인한 새 토큰은 정상
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('무효화된 토큰으로는 쓰기 API도 401', async () => {
    const { server, base } = await startServer(createMemorySessionStore());
    try {
      const old = cookieAt(Date.now());
      await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: headers(old) });
      const res = await fetch(`${base}/api/stories`, { method: 'POST', body: '{}', headers: headers(old) });
      assert.equal(res.status, 401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('로그인 없이 로그아웃해도 오류가 나지 않는다 (revoked:false)', async () => {
    const { server, base } = await startServer(createMemorySessionStore());
    try {
      const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: headers() });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, revoked: false });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('로그아웃 기록을 읽다 오류가 나면 로그인 안 한 것으로 처리한다 (안전하게 닫힘)', async () => {
    const broken = { getValidAfter: async () => { throw new Error('Firestore 장애'); }, revoke: async () => {} };
    const { server, base } = await startServer(broken);
    const original = console.error;
    console.error = () => {}; // 테스트 출력이 지저분해지지 않게 오류 로그만 잠시 끈다
    try {
      assert.equal(await meOf(base, cookieAt(Date.now())), null);
    } finally {
      console.error = original;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('로그아웃 기록을 쓰다 오류가 나도 쿠키는 지워지고 revoked:false로 알려준다', async () => {
    const broken = { getValidAfter: async () => 0, revoke: async () => { throw new Error('쓰기 실패'); } };
    const { server, base } = await startServer(broken);
    const original = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: headers(cookieAt(Date.now())) });
      assert.deepEqual(await res.json(), { ok: true, revoked: false });
      assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${WEB.SESSION_COOKIE}=;`)));
    } finally {
      console.error = original;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ═════════════════════════════════════════════
// 7단계: 서버가 여러 개여도 함께 세는 속도제한
// ═════════════════════════════════════════════
describe('공유 속도제한 저장소', () => {
  test('서버 두 개가 같은 카운터를 공유하면 합쳐서 센다', async () => {
    const backend = createMemoryRateLimitBackend();
    const serverA = createRateLimitStore('auth', backend);
    const serverB = createRateLimitStore('auth', backend);
    serverA.init({ windowMs: 60_000 });
    serverB.init({ windowMs: 60_000 });
    await serverA.increment('1.2.3.4');
    await serverB.increment('1.2.3.4');
    await serverA.increment('1.2.3.4');
    assert.equal((await serverB.increment('1.2.3.4')).totalHits, 4);
    assert.equal((await serverB.increment('9.9.9.9')).totalHits, 1); // 다른 키는 따로
  });

  test('1분 칸이 바뀌면 0부터 다시 센다, 이름(prefix)이 다르면 따로 센다', async () => {
    let t = 1_700_000_000_000;
    const backend = createMemoryRateLimitBackend();
    const store = createRateLimitStore('write', backend, { now: () => t });
    store.init({ windowMs: 60_000 });
    await store.increment('user:1');
    assert.equal((await store.increment('user:1')).totalHits, 2);
    t += 61_000;
    assert.equal((await store.increment('user:1')).totalHits, 1);

    const other = createRateLimitStore('auth', backend, { now: () => t });
    other.init({ windowMs: 60_000 });
    assert.equal((await other.increment('user:1')).totalHits, 1);
  });

  test('문서 ID는 해시라서 IP나 유저 ID가 그대로 들어가지 않는다', async () => {
    const seen = [];
    const spy = { async hit(docId) { seen.push(docId); return 1; } };
    const store = createRateLimitStore('auth', spy);
    store.init({ windowMs: 60_000 });
    await store.increment('203.0.113.7');
    assert.match(seen[0], /^[0-9a-f]{40}$/);
  });

  test('공유 카운터가 고장 나면 이 서버 메모리로 대신 센다 (제한이 풀리지 않는다)', async () => {
    const broken = { async hit() { throw new Error('Firestore 장애'); } };
    const store = createRateLimitStore('auth', broken);
    store.init({ windowMs: 60_000 });
    const original = console.error;
    console.error = () => {};
    try {
      await store.increment('ip');
      await store.increment('ip');
      assert.equal((await store.increment('ip')).totalHits, 3);
    } finally {
      console.error = original;
    }
  });

  test('HTTP: 서버(라우터) 두 개가 카운터를 공유하면 로그인 요청 21번째에서 429', async () => {
    const backend = createMemoryRateLimitBackend();
    const boot = async () => {
      const app = express();
      app.use(createWebRouter({ sessionStore: createMemorySessionStore(), rateLimitBackend: backend }));
      const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      return { server, base: `http://127.0.0.1:${server.address().port}` };
    };
    const a = await boot();
    const b = await boot();
    try {
      const statuses = [];
      for (let i = 0; i < 21; i += 1) {
        const target = i % 2 === 0 ? a.base : b.base; // 번갈아 두 서버로 보낸다
        statuses.push((await fetch(`${target}/api/auth/login`, { redirect: 'manual' })).status);
      }
      assert.ok(statuses.slice(0, 20).every((code) => code === 302), statuses.join(','));
      assert.equal(statuses[20], 429);
    } finally {
      await Promise.all([a, b].map(({ server }) => new Promise((resolve) => server.close(resolve))));
    }
  });
});

// ═════════════════════════════════════════════
// 삭제 후 일괄 정리 (7-3)
// ═════════════════════════════════════════════
// Firestore 대신 쓰는 가짜 DB: where('==' 또는 '<') / orderBy / limit / batch.delete / doc.delete 만 흉내 낸다.
// batch 하나에 500개를 넘기면 진짜 Firestore처럼 오류를 낸다.
function createFakeDb(seed = {}) {
  const data = new Map(); // 컬렉션 이름 → Map(문서 ID → 내용)
  for (const [name, docs] of Object.entries(seed)) data.set(name, new Map(Object.entries(docs)));
  const col = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  const refOf = (name, id) => ({
    id,
    name,
    get: async () => snapOf(name, id),
    delete: async () => { col(name).delete(id); },
    update: async (fields) => {
      if (!col(name).has(id)) throw new Error('NOT_FOUND');
      Object.assign(col(name).get(id), fields); // FieldValue.increment 같은 값은 그대로 들어간다 (숫자 계산은 흉내 내지 않음)
    },
    create: async (fields) => {
      if (col(name).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      col(name).set(id, { ...fields });
    },
  });
  const snapOf = (name, id) => {
    const content = col(name).get(id);
    return { id, ref: refOf(name, id), exists: content !== undefined, data: () => content, get: (field) => content?.[field] };
  };
  const query = (name, filters = [], order = null, max = Infinity) => ({
    where: (field, op, value) => query(name, [...filters, { field, op, value }], order, max),
    orderBy: (field) => query(name, filters, field, max),
    limit: (n) => query(name, filters, order, n),
    select: () => query(name, filters, order, max), // 7-5: 필드 고르기는 흉내만 낸다
    get: async () => {
      let rows = [...col(name).entries()].filter(([, content]) =>
        filters.every(({ field, op, value }) => (op === '==' ? content[field] === value : content[field] < value)));
      if (order) rows.sort((a, b) => a[1][order] - b[1][order]);
      rows = rows.slice(0, max);
      const docs = rows.map(([id]) => snapOf(name, id));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  return {
    collection: (name) => ({ ...query(name), doc: (id) => refOf(name, id) }),
    batch: () => {
      const refs = [];
      return {
        delete: (ref) => refs.push(ref),
        commit: async () => {
          assert.ok(refs.length <= 500, `배치 한도 초과: ${refs.length}`);
          refs.forEach((ref) => col(ref.name).delete(ref.id));
        },
      };
    },
    size: (name) => col(name).size,
    has: (name, id) => col(name).has(id),
  };
}

// n개의 기록 문서를 만든다: { 'u0_story': { storyId }, ... }
const records = (storyId, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}_${storyId}`, { storyId }]));

describe('삭제 후 일괄 정리 (7-3)', () => {
  test('deleteByStoryId: 400개 배치가 넘는 1000건도 다 지우고, 다른 스토리 기록은 건드리지 않는다', async () => {
    const db = createFakeDb({ [COL.SESSIONS]: { ...records('A', 1000), ...records('B', 3) } });
    assert.equal(await deleteByStoryId(db, COL.SESSIONS, 'A', { budgetMs: 60_000 }), true);
    assert.equal(db.size(COL.SESSIONS), 3);
  });

  test('deleteByStoryId: 기록이 없으면 바로 true', async () => {
    assert.equal(await deleteByStoryId(createFakeDb(), COL.SESSIONS, 'A'), true);
  });

  test('deleteByStoryId: 시간 예산을 넘기면 멈추고 false, 다시 부르면 이어서 끝낸다', async () => {
    const db = createFakeDb({ [COL.SESSIONS]: records('A', 1500) });
    let t = 0;
    const clock = () => (t += 1000); // 부를 때마다 1초씩 흐르는 가짜 시계
    // 예산 2.5초: 400개씩 3번 지우고(1200개) 시간이 끝난다
    assert.equal(await deleteByStoryId(db, COL.SESSIONS, 'A', { budgetMs: 2500, now: clock }), false);
    assert.equal(db.size(COL.SESSIONS), 300);
    assert.equal(await deleteByStoryId(db, COL.SESSIONS, 'A', { budgetMs: 60_000 }), true);
    assert.equal(db.size(COL.SESSIONS), 0);
  });

  test('cleanupStoryRecords: 세션/엔딩 도감/좋아요를 모두 지운다', async () => {
    const db = createFakeDb({
      [COL.SESSIONS]: records('A', 5),
      [COL.ENDINGS]: records('A', 5),
      [COL.LIKES]: { ...records('A', 5), ...records('B', 2) },
    });
    assert.equal(await cleanupStoryRecords(db, 'A', { budgetMs: 60_000 }), true);
    assert.equal(db.size(COL.SESSIONS), 0);
    assert.equal(db.size(COL.ENDINGS), 0);
    assert.equal(db.size(COL.LIKES), 2); // B의 좋아요는 그대로
  });

  test('deleteExpiredRateLimits: 만료된 카운터만 지운다', async () => {
    const db = createFakeDb({
      [COL.RATE_LIMITS]: {
        old1: { count: 3, expireAt: new Date(1000) },
        old2: { count: 1, expireAt: new Date(2000) },
        fresh: { count: 1, expireAt: new Date(Date.now() + 120_000) },
      },
    });
    const result = await deleteExpiredRateLimits(db, { budgetMs: 60_000 });
    assert.deepEqual(result, { deleted: 2, done: true });
    assert.equal(db.has(COL.RATE_LIMITS, 'fresh'), true);
    assert.equal(db.size(COL.RATE_LIMITS), 1);
  });

  test('runCleanup: 쪽지가 있는 스토리의 기록만 지우고 쪽지도 버린다 (쪽지 없는 스토리는 건드리지 않는다)', async () => {
    const db = createFakeDb({
      [COL.CLEANUP_TASKS]: {
        A: { storyId: 'A', createdAt: 1 },
        B: { storyId: 'B', createdAt: 2 },
      },
      [COL.SESSIONS]: { ...records('A', 900), ...records('B', 10), ...records('C', 10) },
      [COL.ENDINGS]: records('A', 4),
      [COL.LIKES]: records('B', 4),
      [COL.RATE_LIMITS]: { old: { count: 1, expireAt: new Date(1000) }, fresh: { count: 1, expireAt: new Date(Date.now() + 120_000) } },
    });
    const result = await runCleanup(db, { budgetMs: 60_000 });
    assert.deepEqual(result, { tasksDone: 2, tasksLeft: 0, rateLimitsDeleted: 1, rateLimitsDone: true });
    assert.equal(db.size(COL.CLEANUP_TASKS), 0);
    assert.equal(db.size(COL.SESSIONS), 10); // C만 남는다
    assert.equal(db.size(COL.ENDINGS), 0);
    assert.equal(db.size(COL.LIKES), 0);
    assert.equal(db.has(COL.RATE_LIMITS, 'fresh'), true);
  });

  test('runCleanup: 시간이 모자라면 쪽지를 남기고, 다음 실행에서 이어서 끝낸다', async () => {
    const db = createFakeDb({
      [COL.CLEANUP_TASKS]: { A: { storyId: 'A', createdAt: 1 } },
      [COL.SESSIONS]: records('A', 1500),
    });
    let t = 0;
    const clock = () => (t += 1000);
    const first = await runCleanup(db, { budgetMs: 2500, now: clock });
    assert.equal(first.tasksDone, 0);
    assert.equal(first.tasksLeft, 1);
    assert.equal(db.has(COL.CLEANUP_TASKS, 'A'), true); // 쪽지는 그대로
    assert.ok(db.size(COL.SESSIONS) > 0 && db.size(COL.SESSIONS) < 1500, '일부만 지워져야 한다');

    const second = await runCleanup(db, { budgetMs: 60_000 });
    assert.equal(second.tasksDone, 1);
    assert.equal(db.size(COL.SESSIONS), 0);
    assert.equal(db.size(COL.CLEANUP_TASKS), 0);
  });

  test('runCleanup: 쪽지에 storyId 필드가 없으면 문서 ID를 쓴다', async () => {
    const db = createFakeDb({ [COL.CLEANUP_TASKS]: { A: { createdAt: 1 } }, [COL.SESSIONS]: records('A', 3) });
    await runCleanup(db, { budgetMs: 60_000 });
    assert.equal(db.size(COL.SESSIONS), 0);
  });

  test('isCronAuthorized: 비밀이 짧거나 없으면 항상 거절, 정확히 맞아야 통과', () => {
    const secret = 'a'.repeat(CLEANUP.CRON_SECRET_MIN);
    assert.equal(isCronAuthorized(`Bearer ${secret}`, secret), true);
    assert.equal(isCronAuthorized(`Bearer ${secret}x`, secret), false);
    assert.equal(isCronAuthorized(secret, secret), false); // Bearer 빠짐
    assert.equal(isCronAuthorized(undefined, secret), false);
    assert.equal(isCronAuthorized('Bearer short', 'short'), false); // 비밀이 너무 짧음
    assert.equal(isCronAuthorized('Bearer undefined', undefined), false);
  });

  describe('GET /api/cron/cleanup (HTTP)', () => {
    let server;
    let base;
    let calls;
    const saved = process.env.CRON_SECRET;
    const SECRET = 'test-cron-secret-1234567890';

    before(async () => {
      calls = [];
      const app = express();
      app.use(createWebRouter({
        sessionStore: createMemorySessionStore(),
        rateLimitBackend: createMemoryRateLimitBackend(),
        cleanupRunner: async (options) => { calls.push(options); return { tasksDone: 1, tasksLeft: 0, rateLimitsDeleted: 2, rateLimitsDone: true }; },
      }));
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
      await new Promise((resolve) => server.close(resolve));
    });

    test('CRON_SECRET이 없거나 짧으면 503 (아무도 못 부른다)', async () => {
      delete process.env.CRON_SECRET;
      assert.equal((await fetch(`${base}/api/cron/cleanup`)).status, 503);
      process.env.CRON_SECRET = 'short';
      assert.equal((await fetch(`${base}/api/cron/cleanup`, { headers: { Authorization: 'Bearer short' } })).status, 503);
      assert.equal(calls.length, 0);
    });

    test('헤더가 없거나 틀리면 401, 맞으면 200과 결과', async () => {
      process.env.CRON_SECRET = SECRET;
      assert.equal((await fetch(`${base}/api/cron/cleanup`)).status, 401);
      assert.equal((await fetch(`${base}/api/cron/cleanup`, { headers: { Authorization: 'Bearer wrong-secret-value-0000' } })).status, 401);
      assert.equal(calls.length, 0);

      const ok = await fetch(`${base}/api/cron/cleanup`, { headers: { Authorization: `Bearer ${SECRET}` } });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, tasksDone: 1, tasksLeft: 0, rateLimitsDeleted: 2, rateLimitsDone: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].budgetMs, CLEANUP.CRON_BUDGET_MS);
    });
  });
});

// ═════════════════════════════════════════════
// 신고 / 숨김 / 사용자 차단 (7-4)
// ═════════════════════════════════════════════
describe('신고/숨김/차단 (7-4)', () => {
  const ADMIN_ID = '444444444444444444';
  const TARGET_ID = '555555555555555555';
  const READER_ID = '666666666666666666';
  const stories = () => ({
    pub: { authorId: '111111111111111111', title: '공개글', isPublic: true },
    priv: { authorId: '111111111111111111', title: '비공개글', isPublic: false },
    hid: { authorId: '111111111111111111', title: '숨김글', isPublic: true, hidden: true },
  });

  test('운영자 목록: 숫자 ID만 인정하고, 비어 있으면 아무도 운영자가 아니다', () => {
    const env = { ADMIN_DISCORD_IDS: ` ${ADMIN_ID}, abc ,${TARGET_ID},, 12 ` };
    assert.deepEqual([...getAdminIds(env)], [ADMIN_ID, TARGET_ID]);
    assert.equal(isAdminId(ADMIN_ID, env), true);
    assert.equal(isAdminId('abc', env), false);
    assert.equal(isAdminId(ADMIN_ID, {}), false);
    assert.equal(isAdminId(undefined, env), false);
  });

  test('isHiddenFrom: 숨긴 스토리는 제작자 본인에게만 보인다', () => {
    const story = { authorId: 'A', hidden: true };
    assert.equal(isHiddenFrom(story, 'B'), true);
    assert.equal(isHiddenFrom(story, 'A'), false);
    assert.equal(isHiddenFrom({ authorId: 'A' }, 'B'), false);
    assert.equal(isHiddenFrom(null, 'B'), false);
  });

  test('둘러보기: 숨긴 스토리는 목록, 검색, 태그 집계에서 빠진다', () => {
    const all = [
      { id: '1', title: '보임', tags: ['a'], createdAt: 2 },
      { id: '2', title: '숨김', tags: ['secret'], hidden: true, createdAt: 1 },
    ];
    const result = filterPublicStories(all, {});
    assert.deepEqual(result.stories.map((x) => x.id), ['1']);
    assert.equal(result.total, 1);
    assert.deepEqual(result.tags.map((x) => x.tag), ['a']);
    assert.equal(filterPublicStories(all, { q: '숨김' }).total, 0);
  });

  test('reportStory: 신고가 저장되고, 같은 사람의 두 번째 신고는 already', async () => {
    const db = createFakeDb({ [COL.STORIES]: stories() });
    const first = await reportStory(db, READER_ID, 'pub', { reason: 'spam', detail: '광고예요' }, 1000);
    assert.deepEqual(first, { ok: true, already: false });
    const saved = await db.collection(COL.REPORTS).doc(`${READER_ID}_pub`).get();
    assert.equal(saved.get('status'), 'open');
    assert.equal(saved.get('reason'), 'spam');
    assert.equal(saved.get('storyTitle'), '공개글');
    assert.equal(saved.get('authorId'), '111111111111111111');

    const second = await reportStory(db, READER_ID, 'pub', { reason: 'other' });
    assert.deepEqual(second, { ok: true, already: true });
    assert.equal(db.size(COL.REPORTS), 1);
    assert.equal(saved.get('reason'), 'spam'); // 처음 신고가 그대로
  });

  test('reportStory: 내 스토리는 OWN_STORY, 없는/비공개/숨김 스토리는 모두 NO_STORY', async () => {
    const db = createFakeDb({ [COL.STORIES]: stories() });
    assert.equal((await reportStory(db, '111111111111111111', 'pub', { reason: 'spam' })).code, 'OWN_STORY');
    for (const id of ['nope', 'priv', 'hid']) {
      assert.equal((await reportStory(db, READER_ID, id, { reason: 'spam' })).code, 'NO_STORY', id);
    }
    assert.equal(db.size(COL.REPORTS), 0);
  });

  test('setStoryHidden: 숨김/해제, 없는 스토리는 NO_STORY', async () => {
    const db = createFakeDb({ [COL.STORIES]: stories() });
    assert.deepEqual(await setStoryHidden(db, 'pub', true, { adminId: ADMIN_ID, reason: '스팸' }, 5000), { ok: true, hidden: true });
    let doc = await db.collection(COL.STORIES).doc('pub').get();
    assert.equal(doc.get('hidden'), true);
    assert.equal(doc.get('hiddenBy'), ADMIN_ID);
    assert.equal(doc.get('hiddenReason'), '스팸');
    assert.equal(doc.get('hiddenAt'), 5000);

    await setStoryHidden(db, 'pub', false, { adminId: ADMIN_ID });
    doc = await db.collection(COL.STORIES).doc('pub').get();
    assert.equal(doc.get('hidden'), false);
    assert.equal(doc.get('hiddenReason'), '');
    assert.equal((await setStoryHidden(db, 'nope', true)).code, 'NO_STORY');
  });

  test('listReports/resolveReport: 최신순, 상태별 목록, 처리 표시', async () => {
    const db = createFakeDb({
      [COL.REPORTS]: {
        [`${READER_ID}_a`]: { storyId: 'a', status: 'open', createdAt: 1 },
        [`${READER_ID}_b`]: { storyId: 'b', status: 'open', createdAt: 3 },
        [`${READER_ID}_c`]: { storyId: 'c', status: 'resolved', createdAt: 2 },
      },
    });
    assert.deepEqual((await listReports(db)).map((r) => r.storyId), ['b', 'a']);
    assert.deepEqual((await listReports(db, { status: 'resolved' })).map((r) => r.storyId), ['c']);
    assert.equal((await listReports(db, { limit: 1 })).length, 1);

    assert.deepEqual(await resolveReport(db, `${READER_ID}_b`, 'dismissed', ADMIN_ID, 9000), { ok: true, status: 'dismissed' });
    const doc = await db.collection(COL.REPORTS).doc(`${READER_ID}_b`).get();
    assert.equal(doc.get('status'), 'dismissed');
    assert.equal(doc.get('handledBy'), ADMIN_ID);
    assert.deepEqual((await listReports(db)).map((r) => r.storyId), ['a']);

    assert.equal((await resolveReport(db, '../hack', 'resolved')).code, 'BAD_ID');
    assert.equal((await resolveReport(db, `${READER_ID}_a`, 'open')).code, 'BAD_STATUS');
    assert.equal((await resolveReport(db, `${READER_ID}_zzz`, 'resolved')).code, 'NO_REPORT');
  });

  test('메모리 세션 저장소: 차단하면 기존 로그인이 끊기고, 해제하면 차단만 풀린다', async () => {
    const store = createMemorySessionStore();
    assert.equal(await store.isBlocked(TARGET_ID), false);
    await store.setBlocked(TARGET_ID, true, { now: 10_000 });
    assert.equal(await store.isBlocked(TARGET_ID), true);
    assert.equal(await store.getValidAfter(TARGET_ID), 10_000);
    await store.setBlocked(TARGET_ID, false);
    assert.equal(await store.isBlocked(TARGET_ID), false);
    assert.equal(await store.getValidAfter(TARGET_ID), 10_000); // 풀어도 예전 토큰은 계속 무효
  });

  describe('HTTP', () => {
    let server;
    let base;
    const savedAdmins = process.env.ADMIN_DISCORD_IDS;
    const cookieFor = (id, now) => `${WEB.SESSION_COOKIE}=${signJwt({ sub: id, name: '테스터', avatar: null }, undefined, now)}`;
    const headers = (cookie) => ({ 'Content-Type': 'application/json', [WEB.CSRF_HEADER]: WEB.CSRF_VALUE, ...(cookie ? { Cookie: cookie } : {}) });
    const send = (method, path, cookie, body) =>
      fetch(`${base}${path}`, { method, headers: headers(cookie), ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }) }); // GET에는 본문을 못 싣는다

    before(async () => {
      process.env.ADMIN_DISCORD_IDS = ADMIN_ID;
      const app = express();
      app.use(express.json());
      app.use(createWebRouter({ sessionStore: createMemorySessionStore(), rateLimitBackend: createMemoryRateLimitBackend() }));
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      if (savedAdmins === undefined) delete process.env.ADMIN_DISCORD_IDS; else process.env.ADMIN_DISCORD_IDS = savedAdmins;
      await new Promise((resolve) => server.close(resolve));
    });

    test('신고: 로그인 필요(401), 보안 헤더 필요(403), 잘못된 사유/긴 설명은 DB 전에 400', async () => {
      const cookie = cookieFor(READER_ID);
      assert.equal((await send('POST', '/api/stories/abc/report', undefined, { reason: 'spam' })).status, 401);
      const noHeader = await fetch(`${base}/api/stories/abc/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{"reason":"spam"}' });
      assert.equal(noHeader.status, 403);
      assert.equal((await send('POST', '/api/stories/abc/report', cookie, { reason: 'hack' })).status, 400);
      assert.equal((await send('POST', '/api/stories/abc/report', cookie, {})).status, 400);
      assert.equal((await send('POST', '/api/stories/abc/report', cookie, { reason: 'spam', detail: 'ㅋ'.repeat(MODERATION.DETAIL_MAX + 1) })).status, 400);
      assert.equal((await send('POST', '/api/stories/abc/report', cookie, { reason: 'spam', detail: 123 })).status, 400);
      assert.equal((await send('POST', '/api/stories/bad id!/report', cookie, { reason: 'spam' })).status, 400);
    });

    test('운영 주소: 비로그인 401, 운영자가 아니면 404, 운영자는 입력 검사까지 통과해야 한다', async () => {
      const user = cookieFor(READER_ID);
      const admin = cookieFor(ADMIN_ID);
      const paths = [
        ['GET', '/api/admin/reports'],
        ['PUT', '/api/admin/reports/1234567890_abc'],
        ['PUT', '/api/admin/stories/abc/hidden'],
        ['PUT', `/api/admin/users/${TARGET_ID}/blocked`],
      ];
      for (const [method, path] of paths) {
        assert.equal((await send(method, path, undefined, {})).status, 401, `비로그인 ${path}`);
        assert.equal((await send(method, path, user, {})).status, 404, `일반 사용자 ${path}`);
      }
      assert.equal((await send('GET', '/api/admin/reports?status=weird', admin)).status, 400);
      assert.equal((await send('PUT', '/api/admin/reports/..%2Fhack', admin, { status: 'resolved' })).status, 400);
      assert.equal((await send('PUT', '/api/admin/stories/abc/hidden', admin, { hidden: 'yes' })).status, 400);
      assert.equal((await send('PUT', '/api/admin/stories/abc/hidden', admin, { hidden: true, reason: 'ㅋ'.repeat(MODERATION.NOTE_MAX + 1) })).status, 400);
      assert.equal((await send('PUT', '/api/admin/users/abc/blocked', admin, { blocked: true })).status, 400);
      assert.equal((await send('PUT', `/api/admin/users/${TARGET_ID}/blocked`, admin, { blocked: 'yes' })).status, 400);
      assert.equal((await send('PUT', `/api/admin/users/${ADMIN_ID}/blocked`, admin, { blocked: true })).status, 400); // 운영자는 차단 불가
    });

    test('/api/auth/me: 운영자에게만 isAdmin:true', async () => {
      const asAdmin = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookieFor(ADMIN_ID) } })).json();
      const asUser = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookieFor(READER_ID) } })).json();
      const anon = await (await fetch(`${base}/api/auth/me`)).json();
      assert.equal(asAdmin.isAdmin, true);
      assert.equal(asUser.isAdmin, false);
      assert.equal(anon.isAdmin, false);
      assert.equal(anon.user, null);
    });

    test('사용자 차단: 바로 로그인 상태가 끊기고, 해제 뒤 새로 발급한 토큰은 다시 쓸 수 있다', async () => {
      const admin = cookieFor(ADMIN_ID);
      const meOf = async (cookie) => (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user;

      const before = cookieFor(TARGET_ID);
      assert.equal((await meOf(before))?.id, TARGET_ID);

      const blocked = await send('PUT', `/api/admin/users/${TARGET_ID}/blocked`, admin, { blocked: true, reason: '테스트' });
      assert.equal(blocked.status, 200);
      assert.equal((await meOf(before)), null);                                     // 기존 토큰 끊김
      assert.equal((await meOf(cookieFor(TARGET_ID, Date.now() + 5000))), null);   // 새 토큰도 차단 중에는 안 됨

      const unblocked = await send('PUT', `/api/admin/users/${TARGET_ID}/blocked`, admin, { blocked: false });
      assert.equal(unblocked.status, 200);
      assert.equal((await meOf(before)), null);                                     // 예전 토큰은 계속 무효
      assert.equal((await meOf(cookieFor(TARGET_ID, Date.now() + 5000)))?.id, TARGET_ID); // 새로 발급한 토큰은 OK
    });
  });
});

// ═════════════════════════════════════════════
// 7-5: 검색 확장
// ═════════════════════════════════════════════
describe('검색 확장 (7-5)', () => {
  // 어떤 질의가 만들어졌는지 기록만 하는 가짜 DB. rows 를 돌려준다.
  function recordingDb(rows = [], { fail = null } = {}) {
    const calls = [];
    const q = {};
    for (const method of ['where', 'orderBy', 'limit']) q[method] = (...args) => { calls.push([method, ...args]); return q; };
    q.get = async () => {
      calls.push(['get']);
      if (fail) throw fail;
      return { docs: rows.map(([id, data]) => ({ id, data: () => data })) };
    };
    return { calls, db: { collection: (name) => { calls.push(['collection', name]); return q; } } };
  }
  const queryCount = (calls) => calls.filter(([m]) => m === 'get').length;

  test('검색 열쇠: 소문자로 바꾸고, 빈 태그는 버리고, 개수를 제한한다', () => {
    assert.deepEqual(searchKeys('  지하철 Metro ', ['생존', 'METRO', ' ', 'a', 'b', 'c', 'd']), {
      titleKey: '지하철 metro',
      tagKeys: ['생존', 'metro', 'a', 'b', 'c'],
    });
    assert.deepEqual(searchKeys(undefined, undefined), { titleKey: '', tagKeys: [] });
    assert.equal(searchKeys('가'.repeat(80), []).titleKey.length, 50);
  });

  test('추가 조회 계획: 기본은 없음, 태그/검색어/인기순일 때만', () => {
    assert.deepEqual(planPublicSearch({}), []);
    assert.deepEqual(planPublicSearch({ sort: 'latest' }), []);
    assert.deepEqual(planPublicSearch({ tag: ' 생존 ' }), [{ kind: 'tag', key: '생존' }]);
    assert.deepEqual(planPublicSearch({ tag: 'Metro', q: '무시됨', sort: 'popular' }), [{ kind: 'tag', key: 'metro' }]); // 태그가 있으면 태그 조회 하나로 충분
    assert.deepEqual(planPublicSearch({ q: 'Abc' }), [{ kind: 'title', key: 'abc' }]);
    assert.deepEqual(planPublicSearch({ sort: 'popular' }), [{ kind: 'popular', key: '' }]);
    assert.deepEqual(planPublicSearch({ q: 'x', sort: 'popular' }), [{ kind: 'title', key: 'x' }, { kind: 'popular', key: '' }]);
    assert.deepEqual(planPublicSearch({ q: '   ' }), []); // 공백만 있는 검색어는 검색이 아니다
  });

  test('질의 모양: 항상 공개 스토리만, 종류별 조건과 상한', () => {
    const popular = recordingDb();
    buildSliceQuery(popular.db, { kind: 'popular', key: '' });
    assert.deepEqual(popular.calls, [
      ['collection', COL.STORIES], ['where', 'isPublic', '==', true],
      ['orderBy', 'likeCount', 'desc'], ['orderBy', 'playCount', 'desc'], ['limit', BROWSE.SLICE_MAX],
    ]);

    const tag = recordingDb();
    buildSliceQuery(tag.db, { kind: 'tag', key: '생존' });
    assert.deepEqual(tag.calls, [
      ['collection', COL.STORIES], ['where', 'isPublic', '==', true],
      ['where', 'tagKeys', 'array-contains', '생존'], ['orderBy', 'createdAt', 'desc'], ['limit', BROWSE.SLICE_MAX],
    ]);

    const title = recordingDb();
    buildSliceQuery(title.db, { kind: 'title', key: '지하' });
    assert.deepEqual(title.calls, [
      ['collection', COL.STORIES], ['where', 'isPublic', '==', true],
      ['where', 'titleKey', '>=', '지하'], ['where', 'titleKey', '<=', '지하\uf8ff'], ['orderBy', 'titleKey'], ['limit', BROWSE.TITLE_SLICE_MAX],
    ]);
  });

  test('추가 조회 결과는 요약 모양으로 바뀌고 60초 동안 기억된다', async () => {
    clearPublicCache();
    const { db, calls } = recordingDb([['s1', { title: '옛 이야기', authorId: 'a', tags: ['생존'], createdAt: 5 }]]);
    const slice = { kind: 'tag', key: '생존' };

    const first = await loadPublicSlice(slice, { db, now: 1000 });
    assert.equal(first[0].id, 's1');
    assert.equal(first[0].title, '옛 이야기');
    assert.equal(first[0].config, undefined); // 목록용 요약에는 config 가 없다

    await loadPublicSlice(slice, { db, now: 1000 + BROWSE.CACHE_MS - 1 });
    assert.equal(queryCount(calls), 1, '기억 시간 안에는 다시 읽지 않는다');
    await loadPublicSlice(slice, { db, now: 1000 + BROWSE.CACHE_MS });
    assert.equal(queryCount(calls), 2, '시간이 지나면 다시 읽는다');
  });

  test('추가 조회가 실패해도 오류를 던지지 않고 빈 목록, 실패도 잠깐 기억한다', async () => {
    clearPublicCache();
    const logged = mock.method(console, 'error', () => {});
    try {
      const { db, calls } = recordingDb([], { fail: new Error('FAILED_PRECONDITION: The query requires an index.') });
      const slice = { kind: 'popular', key: '' };
      assert.deepEqual(await loadPublicSlice(slice, { db, now: 5 }), []);
      assert.deepEqual(await loadPublicSlice(slice, { db, now: 6 }), []);
      assert.equal(queryCount(calls), 1, '같은 실패 요청이 계속 DB를 두드리지 않는다');
      assert.equal(logged.mock.callCount(), 1);
    } finally {
      logged.mock.restore();
    }
  });

  test('기억 목록은 상한을 넘으면 가장 오래된 것부터 버린다', async () => {
    clearPublicCache();
    const { db, calls } = recordingDb();
    for (let i = 0; i < BROWSE.SLICE_CACHE_ENTRIES + 3; i += 1) await loadPublicSlice({ kind: 'title', key: `k${i}` }, { db, now: 1 });
    const before = queryCount(calls);
    await loadPublicSlice({ kind: 'title', key: `k${BROWSE.SLICE_CACHE_ENTRIES + 2}` }, { db, now: 2 }); // 가장 최근 것: 기억됨
    assert.equal(queryCount(calls), before);
    await loadPublicSlice({ kind: 'title', key: 'k0' }, { db, now: 2 }); // 가장 오래된 것: 이미 버려짐
    assert.equal(queryCount(calls), before + 1);
  });

  test('합치기: 중복 제거(먼저 나온 것 우선) + 최신순 정렬', () => {
    const a = [{ id: 'x', createdAt: 5, title: 'A의 x' }, { id: 'y', createdAt: 9 }];
    const b = [{ id: 'x', createdAt: 5, title: 'B의 x' }, { id: 'z', createdAt: 1 }];
    const merged = mergePublicStories(a, b);
    assert.deepEqual(merged.map((m) => m.id), ['y', 'x', 'z']);
    assert.equal(merged.find((m) => m.id === 'x').title, 'A의 x');
    assert.deepEqual(mergePublicStories([], []), []);
  });

  test('시나리오: 최신 200개 밖의 옛 스토리도 태그/검색으로 찾는다 (합친 뒤 거르기)', () => {
    const mk = (id, extra) => ({ id, title: id, description: '', tags: [], likeCount: 0, playCount: 0, createdAt: 0, ...extra });
    const latest = Array.from({ length: 5 }, (_, i) => mk(`new${i}`, { createdAt: 100 - i }));
    const old = [mk('옛날 생존기', { tags: ['생존'], createdAt: 1, likeCount: 9 })];
    const all = mergePublicStories(latest, old);
    assert.equal(filterPublicStories(latest, { tag: '생존' }).total, 0, '합치기 전에는 못 찾는다');
    assert.equal(filterPublicStories(all, { tag: '생존' }).stories[0].id, '옛날 생존기');
    assert.equal(filterPublicStories(all, { q: '옛날' }).total, 1);
    assert.equal(filterPublicStories(all, { sort: 'popular' }).stories[0].id, '옛날 생존기'); // 인기순 1위
  });

  test('숨긴 스토리는 추가 조회로 들어와도 목록에서 빠진다', () => {
    const hiddenOne = { id: 'h', title: 'h', tags: ['생존'], hidden: true, createdAt: 3 };
    const visible = { id: 'v', title: 'v', tags: ['생존'], createdAt: 2 };
    const result = filterPublicStories(mergePublicStories([], [hiddenOne, visible]), { tag: '생존' });
    assert.deepEqual(result.stories.map((s) => s.id), ['v']);
  });

  test('열쇠 채우기(reindex): 빠진/틀린 문서만 고치고, 연습 모드는 아무것도 안 바꾼다', async () => {
    const db = createFakeDb({
      [COL.STORIES]: {
        a: { title: 'Metro 이야기', tags: ['생존', 'METRO'] },                                   // 열쇠 없음 → 채움
        b: { title: '시장', tags: ['시장'], titleKey: '시장', tagKeys: ['시장'], updatedAt: 7 }, // 이미 맞음 → 그대로
        c: { title: '고친 제목', tags: [], titleKey: '옛 제목', tagKeys: [] },                   // 틀림 → 고침
      },
    });
    assert.deepEqual(await reindexSearchKeys(db, { dryRun: true }), { total: 3, updated: 2 });
    assert.equal((await db.collection(COL.STORIES).doc('a').get()).get('titleKey'), undefined);

    assert.deepEqual(await reindexSearchKeys(db), { total: 3, updated: 2 });
    const a = (await db.collection(COL.STORIES).doc('a').get()).data();
    assert.deepEqual([a.titleKey, a.tagKeys], ['metro 이야기', ['생존', 'metro']]);
    assert.equal((await db.collection(COL.STORIES).doc('c').get()).get('titleKey'), '고친 제목');
    assert.equal((await db.collection(COL.STORIES).doc('b').get()).get('updatedAt'), 7); // updatedAt 은 건드리지 않음

    assert.deepEqual(await reindexSearchKeys(db), { total: 3, updated: 0 }); // 두 번째 실행은 할 일이 없다
  });
});

// ═════════════════════════════════════════════
// 7-6: 요청 크기 + 배포 점검
// ═════════════════════════════════════════════
describe('요청 크기와 배포 점검 (7-6)', () => {
  const goodEnv = () => ({
    SITE_URL: 'https://example.vercel.app',
    JWT_SECRET: 'x'.repeat(40),
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'secret',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from(JSON.stringify({ project_id: 'p', client_email: 'e@x', private_key: 'k' })).toString('base64'),
    CRON_SECRET: 'c'.repeat(20),
    ADMIN_DISCORD_IDS: '123456789012345678',
  });
  const goodVercel = { crons: [{ path: '/api/cron/cleanup', schedule: '0 18 * * *' }] };
  const by = (results, name) => results.filter((r) => r.name === name);
  const levels = (results) => results.map((r) => r.level);

  test('크기 글자를 바이트로 바꾼다', () => {
    assert.equal(sizeToBytes('200kb'), 200 * 1024);
    assert.equal(sizeToBytes('1.5mb'), 1.5 * 1024 * 1024);
    assert.equal(sizeToBytes('10 B'), 10);
    assert.ok(Number.isNaN(sizeToBytes('많이')));
  });

  test('서버 한도는 Vercel 한도(4.5MB)보다 작다', () => {
    assert.ok(sizeToBytes(REQUEST_LIMITS.DEFAULT) <= sizeToBytes(REQUEST_LIMITS.SCENE_SAVE));
    assert.ok(sizeToBytes(REQUEST_LIMITS.SCENE_SAVE) < REQUEST_LIMITS.VERCEL_MAX_BYTES);
    assert.equal(REQUEST_LIMITS.VERCEL_MAX_BYTES, 4_500_000);
  });

  test('모두 올바르면 오류도 경고도 없다 (운영 기준)', () => {
    const results = checkDeployment({ env: goodEnv(), vercelJson: goodVercel, isProduction: true });
    assert.deepEqual(results.filter((r) => r.level !== 'ok'), []);
  });

  test('점검 결과에 비밀 값이 들어가지 않는다', () => {
    const env = goodEnv();
    const dump = JSON.stringify(checkDeployment({ env, vercelJson: goodVercel, isProduction: true }));
    for (const key of ['JWT_SECRET', 'DISCORD_CLIENT_SECRET', 'FIREBASE_SERVICE_ACCOUNT_BASE64', 'CRON_SECRET']) {
      assert.ok(!dump.includes(env[key]), `${key} 값이 결과에 나왔습니다`);
    }
  });

  test('빈 환경은 필수 항목마다 오류', () => {
    const results = checkDeployment({ env: {}, vercelJson: goodVercel, isProduction: true });
    for (const name of ['SITE_URL', 'JWT_SECRET', 'DISCORD_APPLICATION_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_PUBLIC_KEY', 'FIREBASE_SERVICE_ACCOUNT_BASE64', 'CRON_SECRET']) {
      assert.equal(by(results, name)[0]?.level, 'error', `${name} 은(는) 오류여야 합니다`);
    }
    assert.equal(by(results, 'ADMIN_DISCORD_IDS')[0].level, 'warn'); // 운영자 없음은 경고
  });

  test('SITE_URL: 끝의 /, http, localhost 는 운영에서 오류', () => {
    const run = (SITE_URL, isProduction = true) => by(checkDeployment({ env: { ...goodEnv(), SITE_URL }, vercelJson: goodVercel, isProduction }), 'SITE_URL')[0].level;
    assert.equal(run('https://example.vercel.app/'), 'error');
    assert.equal(run('http://example.com'), 'error');
    assert.equal(run('https://localhost:3000'), 'error');
    assert.equal(run('https://example.vercel.app'), 'ok');
    assert.equal(run('http://localhost:5173', false), 'ok'); // 개발 기준에서는 localhost 가 정상
    assert.equal(run('http://localhost:5173/', false), 'error'); // 끝의 / 는 개발에서도 오류
  });

  test('Redirect 주소 안내는 SITE_URL 이 올바를 때만 나온다', () => {
    const ok = checkDeployment({ env: goodEnv(), vercelJson: goodVercel, isProduction: true });
    assert.ok(by(ok, '디스코드 포털 Redirects')[0].message.includes('https://example.vercel.app/api/auth/callback'));
    const bad = checkDeployment({ env: { ...goodEnv(), SITE_URL: '' }, vercelJson: goodVercel, isProduction: true });
    assert.equal(by(bad, '디스코드 포털 Redirects').length, 0);
  });

  test('짧은 비밀/잘못된 키/깨진 서비스 계정은 오류', () => {
    const run = (patch, name) => by(checkDeployment({ env: { ...goodEnv(), ...patch }, vercelJson: goodVercel, isProduction: true }), name)[0].level;
    assert.equal(run({ JWT_SECRET: 'x'.repeat(31) }, 'JWT_SECRET'), 'error');
    assert.equal(run({ CRON_SECRET: 'c'.repeat(CLEANUP.CRON_SECRET_MIN - 1) }, 'CRON_SECRET'), 'error');
    assert.equal(run({ DISCORD_PUBLIC_KEY: 'z'.repeat(64) }, 'DISCORD_PUBLIC_KEY'), 'error');
    assert.equal(run({ DISCORD_APPLICATION_ID: 'abc' }, 'DISCORD_APPLICATION_ID'), 'error');
    assert.equal(run({ FIREBASE_SERVICE_ACCOUNT_BASE64: '!!!' }, 'FIREBASE_SERVICE_ACCOUNT_BASE64'), 'error');
    assert.equal(run({ FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from('{"project_id":"p"}').toString('base64') }, 'FIREBASE_SERVICE_ACCOUNT_BASE64'), 'error');
  });

  test('개발 기준에서는 CRON_SECRET 없음이 경고(오류 아님)', () => {
    const { CRON_SECRET, ...env } = goodEnv();
    const results = checkDeployment({ env, vercelJson: goodVercel, isProduction: false });
    assert.equal(by(results, 'CRON_SECRET')[0].level, 'warn');
    assert.ok(!levels(results).includes('error'));
  });

  test('운영자 ID 형식이 섞이면 경고', () => {
    const run = (ADMIN_DISCORD_IDS) => by(checkDeployment({ env: { ...goodEnv(), ADMIN_DISCORD_IDS }, vercelJson: goodVercel, isProduction: true }), 'ADMIN_DISCORD_IDS')[0].level;
    assert.equal(run('123456789012345678, 223456789012345678'), 'ok');
    assert.equal(run('123456789012345678, 홍길동'), 'warn');
  });

  test('vercel.json 크론: 없거나 하루 한 번 모양이 아니면 경고', () => {
    const run = (vercelJson) => by(checkDeployment({ env: goodEnv(), vercelJson, isProduction: true }), vercelJson ? 'vercel.json crons' : 'vercel.json')[0].level;
    assert.equal(run(goodVercel), 'ok');
    assert.equal(run({}), 'warn');
    assert.equal(run({ crons: [{ path: '/api/other', schedule: '0 18 * * *' }] }), 'warn');
    assert.equal(run({ crons: [{ path: '/api/cron/cleanup', schedule: '*/5 * * * *' }] }), 'warn');
    assert.equal(run(null), 'warn'); // 파일을 못 읽음
  });
});

// ═════════════════════════════════════════════
// 봇: 공개 메시지 / 채널 제한 / 버튼 주인 확인
// ═════════════════════════════════════════════
describe('봇 공개 메시지와 채널 제한', () => {
  const CH_A = '111111111111111111';
  const CH_B = '222222222222222222';
  const ME = '333333333333333333';
  const OTHER = '444444444444444444';

  // 환경 변수를 잠깐 바꿔서 실행하고 원래대로 돌린다
  async function withEnv(patch, fn) {
    const before = {};
    for (const key of Object.keys(patch)) before[key] = process.env[key];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test('기본은 모두에게 보이는 메시지(알림 없이 조용히, 4096), 멘션은 항상 차단', async () => {
    await withEnv({ DISCORD_EPHEMERAL: undefined }, () => {
      const res = reply({ content: '안녕' });
      assert.equal(res.type, 4);
      assert.equal(res.data.flags, 4096); // 조용한 알림(SUPPRESS_NOTIFICATIONS)만 붙는다
      assert.deepEqual(res.data.allowed_mentions, { parse: [] });
    });
  });

  test('DISCORD_EPHEMERAL=true 면 예전처럼 본인에게만 보인다', async () => {
    await withEnv({ DISCORD_EPHEMERAL: 'true' }, () => {
      assert.equal(reply({ content: 'x' }).data.flags, 4096 | 64); // 조용한 알림 + 본인에게만
    });
    await withEnv({ DISCORD_EPHEMERAL: 'false' }, () => {
      assert.equal(reply({ content: 'x' }).data.flags, 4096);
    });
  });

  test('오류 안내는 설정과 상관없이 항상 본인에게만 보인다', async () => {
    await withEnv({ DISCORD_EPHEMERAL: undefined }, () => {
      assert.equal(errorReply('문제').data.flags, 64);
      assert.equal(privateReply({ content: 'x' }).data.flags, 64);
      assert.ok(errorReply('문제').data.content.includes('문제'));
    });
  });

  test('허용 채널 목록: 숫자 ID만 남기고 공백/쉼표를 정리한다', () => {
    assert.deepEqual([...getAllowedChannelIds({ DISCORD_ALLOWED_CHANNEL_IDS: ` ${CH_A} , ${CH_B},abc,, ` })], [CH_A, CH_B]);
    assert.equal(getAllowedChannelIds({}).size, 0);
  });

  test('채널 제한: 비어 있으면 모두 허용, 있으면 그 채널(과 그 안의 스레드)만', () => {
    const env = { DISCORD_ALLOWED_CHANNEL_IDS: CH_A };
    assert.equal(isChannelAllowed({ channel_id: CH_B }, {}), true);
    assert.equal(isChannelAllowed({ channel_id: CH_A }, env), true);
    assert.equal(isChannelAllowed({ channel_id: CH_B }, env), false);
    assert.equal(isChannelAllowed({ channel_id: '999999999999999999', channel: { parent_id: CH_A } }, env), true); // 스레드
    assert.equal(isChannelAllowed({}, env), false); // 채널 정보를 모르면 막는다
    // 전부 틀린 값만 적으면 제한이 없는 것으로 본다 (preflight 가 경고해 준다)
    assert.equal(isChannelAllowed({ channel_id: CH_B }, { DISCORD_ALLOWED_CHANNEL_IDS: 'oops' }), true);
  });

  test('다른 채널의 명령어/버튼은 처리하지 않고 안내만 한다 (DB를 건드리지 않음)', async () => {
    await withEnv({ DISCORD_ALLOWED_CHANNEL_IDS: CH_A }, async () => {
      for (const type of [InteractionType.APPLICATION_COMMAND, InteractionType.MESSAGE_COMPONENT]) {
        const res = await handleInteraction({ type, channel_id: CH_B, member: { user: { id: ME } }, data: { name: '스토리목록', custom_id: 's:sample-001' } });
        assert.equal(res.data.flags, 64);
        assert.ok(res.data.content.includes(`<#${CH_A}>`), '허용된 채널을 알려 준다');
      }
    });
  });

  test('메시지 주인: 새 필드, 옛 필드, 없음', () => {
    assert.equal(getMessageOwnerId({ message: { interaction_metadata: { user: { id: ME } } } }), ME);
    assert.equal(getMessageOwnerId({ message: { interaction: { user: { id: OTHER } } } }), OTHER);
    assert.equal(getMessageOwnerId({ message: {} }), '');
    assert.equal(getMessageOwnerId({}), '');
  });

  test('남의 메시지의 선택/포기 버튼은 막는다 (DB를 건드리지 않음)', async () => {
    await withEnv({ DISCORD_ALLOWED_CHANNEL_IDS: undefined }, async () => {
      const click = (customId) => handleInteraction({
        type: InteractionType.MESSAGE_COMPONENT,
        channel_id: CH_A,
        member: { user: { id: OTHER } },                                   // 누른 사람
        message: { interaction_metadata: { user: { id: ME } } },           // 메시지 주인
        data: { custom_id: customId },
      });
      for (const id of ['c:sample-001:1:0', 'x:sample-001']) {
        const res = await click(id);
        assert.equal(res.data.flags, 64, id);
        assert.ok(res.data.content.includes('다른 사람'), id);
      }
    });
  });

  test('점검: 채널 제한 설정 검사', () => {
    const base = { SITE_URL: 'https://example.vercel.app' };
    const run = (DISCORD_ALLOWED_CHANNEL_IDS) =>
      checkDeployment({ env: { ...base, DISCORD_ALLOWED_CHANNEL_IDS }, vercelJson: null, isProduction: true }).find((r) => r.name === 'DISCORD_ALLOWED_CHANNEL_IDS').level;
    assert.equal(run(undefined), 'ok');
    assert.equal(run(CH_A), 'ok');
    assert.equal(run(`${CH_A}, 오타`), 'warn');
  });
});
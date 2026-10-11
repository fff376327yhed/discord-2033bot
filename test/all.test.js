// 통합 테스트 (엔진 + 메시지 만들기 + 서명 검증 + 4단계 웹 API). 실행: npm test
import { test, describe, before, after } from 'node:test';
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
    const lockedField = message.embeds[0].fields.find((field) => field.name === '잠긴 선택지');
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

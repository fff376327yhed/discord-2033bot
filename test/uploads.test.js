// 사진 업로드 서버 로직 테스트 (진짜 Firestore/Blob 없이 가짜로 돌린다)
// 실행: node --test test/uploads.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerUploadRoutes, sniffImage, checkQuota, monthKey, findBlobToken, hasBlobAuth, blobAuthOptions, UPLOAD_LIMITS } from '../src/uploads.js';

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
process.env.ADMIN_DISCORD_IDS = '999999999999';

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) { if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra }); next(err); }
};
const FieldValue = { increment: (n) => ({ __inc: n }) };

function makeDb() {
  const store = new Map();
  const apply = (p, data, merge) => {
    const cur = merge ? { ...(store.get(p) ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) cur[k] = v && v.__inc !== undefined ? (Number(cur[k]) || 0) + v.__inc : v;
    store.set(p, cur);
  };
  const snap = (p) => ({ exists: store.has(p), id: p.split('/')[1], get: (f) => store.get(p)?.[f] });
  const ref = (p) => ({ path: p, get: async () => snap(p), set: async (d, o) => apply(p, d, o?.merge) });
  const query = (name, field, dir, n) => ({
    limit: (m) => query(name, field, dir, m),
    get: async () => ({
      docs: [...store.keys()].filter((p) => p.startsWith(`${name}/`) && store.get(p)[field] !== undefined)
        .sort((a, b) => (dir === 'desc' ? -1 : 1) * (store.get(a)[field] - store.get(b)[field])).slice(0, n ?? 999).map(snap),
    }),
  });
  const writer = (ops) => ({
    set: (r, d, o) => ops.push(() => apply(r.path, d, o?.merge)),
    delete: (r) => ops.push(() => store.delete(r.path)),
  });
  return {
    store,
    collection: (name) => ({
      doc: (id) => ref(`${name}/${id}`),
      orderBy: (f, d) => query(name, f, d),
      where: (field, op, value) => ({
        limit: (n) => ({ get: async () => ({ docs: [...store.keys()].filter((p) => p.startsWith(`${name}/`) && store.get(p)[field] === value).slice(0, n).map(snap) }) }),
      }),
    }),
    runTransaction: async (fn) => {
      const ops = [];
      const tx = { ...writer(ops), get: async (r) => snap(r.path) };
      await fn(tx);
      ops.forEach((o) => o());
    },
    batch: () => { const ops = []; return { ...writer(ops), commit: async () => ops.forEach((o) => o()) }; },
  };
}

async function start() {
  const db = makeDb();
  const blobFiles = new Map();
  const blob = {
    put: async (pathname, body) => { blobFiles.set(pathname, body.length); return { url: `https://x.public.blob.vercel-storage.com/${pathname}` }; },
    del: async (url) => { blobFiles.delete(new URL(url).pathname.slice(1)); },
    list: async () => ({ blobs: [...blobFiles.values()].map((size) => ({ size })), hasMore: false }),
  };
  const router = express.Router();
  const requireAuth = (req, res, next) => {
    const id = req.get('x-test-user');
    if (!id) return res.status(401).json({ error: '로그인이 필요합니다.' });
    req.user = { id };
    next();
  };
  const isAdminId = (id) => id === '999999999999';
  const requireAdmin = (req, res, next) => requireAuth(req, res, () => (isAdminId(req.user.id) ? next() : res.status(404).json({ error: 'no' })));
  registerUploadRoutes({ router, requireAuth, requireAdmin, writeLimiter: (q, s, n) => n(), getDb: () => db, isAdminId, HttpError, wrap, FieldValue }, { blob });
  const app = express();
  app.use(router);
  app.use((err, req, res, next) => res.status(err?.type === 'entity.too.large' ? 413 : 500).json({ error: String(err?.message) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { db, blobFiles, server, base: `http://127.0.0.1:${server.address().port}` };
}

const webp = (size) => { const b = Buffer.alloc(size); b.write('RIFF', 0); b.write('WEBP', 8); return b; };
const send = (ctx, user, body, type = 'image/webp') => fetch(`${ctx.base}/api/uploads`, { method: 'POST', headers: { 'x-test-user': user, 'content-type': type }, body });

test('매직 바이트로 사진 종류를 알아본다', () => {
  assert.equal(sniffImage(webp(20)), 'image/webp');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<html>hello</html>')), null);
});

test('checkQuota: 일반 유저는 제한, 관리자는 무제한', () => {
  const full = { bytes: UPLOAD_LIMITS.USER_MAX_TOTAL_BYTES - 100, count: 3 };
  assert.equal(checkQuota({ usage: full, size: 200, isAdmin: false }).status, 403);
  assert.equal(checkQuota({ usage: full, size: 200, isAdmin: true }), null);
  assert.equal(checkQuota({ usage: { bytes: 0, count: UPLOAD_LIMITS.USER_MAX_FILES }, size: 10, isAdmin: false }).status, 403);
  assert.equal(checkQuota({ usage: { bytes: 0, count: 0 }, size: 900 * 1024, isAdmin: false }).status, 413);
  assert.equal(checkQuota({ usage: { bytes: 0, count: 0 }, size: 5_000_000, isAdmin: true }).status, 413);
});

test('일반 유저: 업로드 성공 → 사용량 증가 → 삭제하면 원래대로', async () => {
  const ctx = await start();
  try {
    const res = await send(ctx, '111111111111', webp(1000));
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.usage.bytes, 1000);
    assert.equal(data.usage.count, 1);
    assert.equal(ctx.db.store.get('meta/uploadStats').bytes, 1000);
    assert.equal(ctx.blobFiles.size, 1);

    const del = await fetch(`${ctx.base}/api/uploads/${data.id}`, { method: 'DELETE', headers: { 'x-test-user': '111111111111' } });
    assert.equal(del.status, 200);
    assert.equal(ctx.db.store.get('meta/uploadStats').bytes, 0);
    assert.equal(ctx.db.store.get('users/111111111111').uploadCount, 0);
    assert.equal(ctx.blobFiles.size, 0);
  } finally { ctx.server.close(); }
});

test('일반 유저: 너무 큰 사진 / 가짜 사진 / 공간 부족은 거절', async () => {
  const ctx = await start();
  try {
    assert.equal((await send(ctx, '111111111111', webp(900 * 1024))).status, 413);
    assert.equal((await send(ctx, '111111111111', Buffer.from('not an image at all'))).status, 415);
    ctx.db.store.set('users/222222222222', { uploadBytes: UPLOAD_LIMITS.USER_MAX_TOTAL_BYTES - 10, uploadCount: 5 });
    assert.equal((await send(ctx, '222222222222', webp(1000))).status, 403);
    assert.equal(ctx.blobFiles.size, 0);
  } finally { ctx.server.close(); }
});

test('관리자: 공간이 가득 차 있어도, 큰 사진도 올라간다 (4MB 이하)', async () => {
  const ctx = await start();
  try {
    ctx.db.store.set('users/999999999999', { uploadBytes: UPLOAD_LIMITS.USER_MAX_TOTAL_BYTES * 10, uploadCount: 9999 });
    assert.equal((await send(ctx, '999999999999', webp(3_000_000))).status, 201);
    assert.equal((await send(ctx, '999999999999', webp(4_300_000))).status, 413);
  } finally { ctx.server.close(); }
});

test('남의 사진은 못 지우고, 관리자 사용량 주소는 관리자만 본다', async () => {
  const ctx = await start();
  try {
    const { id } = await (await send(ctx, '111111111111', webp(500))).json();
    const other = await fetch(`${ctx.base}/api/uploads/${id}`, { method: 'DELETE', headers: { 'x-test-user': '222222222222' } });
    assert.equal(other.status, 404);
    assert.equal((await fetch(`${ctx.base}/api/admin/upload-stats`, { headers: { 'x-test-user': '111111111111' } })).status, 404);
    const stats = await (await fetch(`${ctx.base}/api/admin/upload-stats`, { headers: { 'x-test-user': '999999999999' } })).json();
    assert.equal(stats.totalBytes, 500);
    assert.equal(stats.totalCount, 1);
    assert.equal(stats.topUsers[0].id, '111111111111');
    assert.equal(stats.recent.length, 1);
    const sync = await (await fetch(`${ctx.base}/api/admin/upload-stats/resync`, { method: 'POST', headers: { 'x-test-user': '999999999999' } })).json();
    assert.equal(sync.totalBytes, 500);
  } finally { ctx.server.close(); }
});

test('checkQuota: 이번 달 횟수 초과 / 저장소 거의 가득 / 이번 달 총 업로드 많음', () => {
  const usage = { bytes: 0, count: 0, monthCount: UPLOAD_LIMITS.USER_MAX_PER_MONTH };
  assert.equal(checkQuota({ usage, size: 10, isAdmin: false }).status, 403);
  assert.equal(checkQuota({ usage, size: 10, isAdmin: true }), null);
  const ok = { bytes: 0, count: 0, monthCount: 0 };
  const full = { bytes: 960, limitBytes: 1000, opsMonthCount: 0, opsLimit: 2000 };
  assert.equal(checkQuota({ usage: ok, size: 10, isAdmin: false, global: full }).status, 503);
  assert.equal(checkQuota({ usage: ok, size: 10, isAdmin: true, global: full }), null);
  const busy = { bytes: 0, limitBytes: 1000, opsMonthCount: 1800, opsLimit: 2000 };
  assert.equal(checkQuota({ usage: ok, size: 10, isAdmin: false, global: busy }).status, 503);
});

test('이번 달 횟수를 다 쓴 유저는 막히고, 지난달 기록은 0부터 다시 센다', async () => {
  const ctx = await start();
  try {
    ctx.db.store.set('users/111111111111', { uploadMonth: monthKey(), uploadMonthCount: UPLOAD_LIMITS.USER_MAX_PER_MONTH });
    assert.equal((await send(ctx, '111111111111', webp(500))).status, 403);
    ctx.db.store.set('users/111111111111', { uploadMonth: '2020-01', uploadMonthCount: 999 });
    const res = await send(ctx, '111111111111', webp(500));
    assert.equal(res.status, 201);
    assert.equal((await res.json()).usage.monthCount, 1);
    assert.equal(ctx.db.store.get('meta/uploadStats').opsMonthCount, 1);
  } finally { ctx.server.close(); }
});

test('저장소가 거의 차면 일반 유저는 막히고 관리자는 올릴 수 있다', async () => {
  const ctx = await start();
  try {
    ctx.db.store.set('meta/uploadStats', { bytes: 1000 * 1024 * 1024, count: 100 }); // 기준 1GB(1024MB) 중 약 98%
    assert.equal((await send(ctx, '111111111111', webp(500))).status, 503);
    assert.equal((await send(ctx, '999999999999', webp(500))).status, 201);
  } finally { ctx.server.close(); }
});

test('내 사진 보관함: 내 것만, 최근 순으로 나온다. 다시 계산해도 이번 달 횟수는 남는다', async () => {
  const ctx = await start();
  try {
    await send(ctx, '111111111111', webp(500));
    await send(ctx, '222222222222', webp(600));
    const mine = await (await fetch(`${ctx.base}/api/uploads/mine/items`, { headers: { 'x-test-user': '111111111111' } })).json();
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0].size, 500);
    await fetch(`${ctx.base}/api/admin/upload-stats/resync`, { method: 'POST', headers: { 'x-test-user': '999999999999' } });
    assert.equal(ctx.db.store.get('meta/uploadStats').opsMonthCount, 2);
    const stats = await (await fetch(`${ctx.base}/api/admin/upload-stats`, { headers: { 'x-test-user': '999999999999' } })).json();
    assert.equal(stats.opsMonthCount, 2);
    assert.equal(stats.opsLimit, 2000);
  } finally { ctx.server.close(); }
});

test('Blob 열쇠 찾기: 기본 이름, 접두어가 바뀐 이름, 없을 때', () => {
  assert.equal(findBlobToken({ BLOB_READ_WRITE_TOKEN: 'a', X_READ_WRITE_TOKEN: 'b' }), 'a');
  assert.equal(findBlobToken({ STORE_READ_WRITE_TOKEN: 'b' }), 'b');
  assert.equal(findBlobToken({ BLOB_STORE_ID: 'x', BLOB_WEBHOOK_PUBLIC_KEY: 'y' }), undefined);
});

test('Blob 인증: 열쇠 방식과 OIDC(BLOB_STORE_ID만 있는) 방식 둘 다 인정한다', () => {
  assert.equal(hasBlobAuth({ BLOB_STORE_ID: 'store_abc', BLOB_WEBHOOK_PUBLIC_KEY: 'k' }), true); // 지금 이 프로젝트의 모양
  assert.deepEqual(blobAuthOptions({ BLOB_STORE_ID: 'store_abc' }), {}); // SDK가 알아서 인증
  assert.equal(hasBlobAuth({ BLOB_READ_WRITE_TOKEN: 't' }), true);
  assert.deepEqual(blobAuthOptions({ BLOB_READ_WRITE_TOKEN: 't' }), { token: 't' });
  assert.equal(hasBlobAuth({}), false);
});

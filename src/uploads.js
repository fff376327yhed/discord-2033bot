// 사진 업로드 (Vercel Blob 사용)
// - 일반 유저: 사진 한 장 크기, 총 용량, 총 개수에 제한이 있다.
// - 관리자(ADMIN_DISCORD_IDS): 용량/개수 제한 없음. (단, 한 장은 Vercel 요청 한도 4.5MB 때문에 4MB까지)
// - 관리자는 /api/admin/upload-stats 로 지금 얼마나 쓰였는지 볼 수 있다. (화면이 5초마다 새로 읽는다)
// 이 파일은 bundle.js 를 import 하지 않는다. (서로 빙글빙글 불러오는 문제 방지)
// 필요한 도구는 registerUploadRoutes() 에 넘겨받는다. 연결은 scripts/apply-upload-patch.mjs 가 해준다.
import { randomUUID } from 'node:crypto';
import express from 'express';

export const UPLOAD_LIMITS = {
  USER_MAX_FILE_BYTES: 800 * 1024,         // 일반 유저: 사진 한 장 최대 800KB (브라우저가 미리 줄여서 보낸다)
  USER_MAX_TOTAL_BYTES: 30 * 1024 * 1024,  // 일반 유저: 내 사진 전체 합계 최대 30MB
  USER_MAX_FILES: 60,                      // 일반 유저: 사진 최대 개수
  USER_MAX_PER_MONTH: 40,                  // 일반 유저: 한 달에 올릴 수 있는 횟수 (Vercel Blob의 "고급 작업" 한도 보호)
  ADMIN_MAX_FILE_BYTES: 4_000_000,         // 관리자: 한 장 4MB (Vercel 요청 한도 4.5MB보다 작게)
  PLATFORM_BODY_BYTES: 4_500_000,          // Vercel 함수 요청 한도
  DEFAULT_STORAGE_LIMIT_MB: 1024,          // 관리자 화면 막대그래프의 기준(1GB). 환경 변수 UPLOAD_STORAGE_LIMIT_MB 로 바꾼다.
  DEFAULT_MONTHLY_OPS_LIMIT: 2000,         // 한 달 업로드 총량의 기준(무료 한도 "Advanced Operations 2k"). 환경 변수 UPLOAD_MONTHLY_OPS_LIMIT 로 바꾼다. (확인 필요)
  OPS_BLOCK_RATIO: 0.9,                    // 이번 달 총 업로드가 기준의 90%를 넘으면 일반 유저 업로드를 잠시 막는다 (관리자는 계속 가능)
  STORAGE_BLOCK_RATIO: 0.95,               // 저장 용량이 기준의 95%를 넘으면 일반 유저 업로드를 잠시 막는다
};

const COL_UPLOADS = 'uploads';   // uploads/{UUID}  사진 한 장당 문서 하나
const COL_USERS = 'users';       // users/{디스코드ID}.uploadBytes / uploadCount
const COL_META = 'meta';         // meta/uploadStats  전체 합계
// 안 쓰는 사진을 찾을 때 장면을 훑는 곳. 이름은 bundle.js 의 COL(STORIES / SCENES / DRAFT_SCENES)과 같아야 한다.
const COL_STORIES = 'stories';
const COL_SCENES = 'scenes';
const COL_DRAFT_SCENES = 'draftScenes';
const UNUSED_GRACE_MS = 10 * 60 * 1000;   // 방금(10분 안에) 올린 사진은 아직 장면에 안 붙였을 수 있어서 후보에서 뺀다
const UNUSED_SCAN_MAX_SCENES = 3000;       // 한 번에 훑을 장면 수 상한 (Firestore 읽기 비용 보호)
const STATS_ID = 'uploadStats';
const BLOB_PREFIX = 'story-images';
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** 파일 맨 앞 글자(매직 바이트)로 진짜 사진인지 확인한다. 이름이나 Content-Type 은 속일 수 있어서 쓰지 않는다. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** 이번 달 이름표. 예) "2026-10" (달이 바뀌면 횟수가 0부터 다시 시작) */
export function monthKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * 올릴 수 있는지 판단한다. 문제가 없으면 null, 있으면 { status, message }. (순수 함수라 테스트하기 쉽다)
 * global: { bytes, limitBytes, opsMonthCount, opsLimit } 전체 사용 현황. 일반 유저만 이 안전장치에 걸린다.
 */
export function checkQuota({ usage, size, isAdmin, limits = UPLOAD_LIMITS, global = null }) {
  if (!(size > 0)) return { status: 400, message: '빈 파일입니다.' };
  if (isAdmin) {
    if (size > limits.ADMIN_MAX_FILE_BYTES) return { status: 413, message: '사진 한 장은 4MB까지만 올릴 수 있습니다. (Vercel 요청 한도)' };
    return null;
  }
  if (size > limits.USER_MAX_FILE_BYTES) return { status: 413, message: `사진 한 장은 ${Math.floor(limits.USER_MAX_FILE_BYTES / 1024)}KB까지만 올릴 수 있습니다.` };
  if (usage.count >= limits.USER_MAX_FILES) return { status: 403, message: `사진은 최대 ${limits.USER_MAX_FILES}장까지 올릴 수 있습니다. 안 쓰는 사진을 지워 주세요.` };
  if (usage.bytes + size > limits.USER_MAX_TOTAL_BYTES) return { status: 403, message: `내 사진 저장 공간(${Math.floor(limits.USER_MAX_TOTAL_BYTES / 1024 / 1024)}MB)이 가득 찼습니다. 안 쓰는 사진을 지워 주세요.` };
  if ((usage.monthCount ?? 0) >= limits.USER_MAX_PER_MONTH) return { status: 403, message: `이번 달 사진 올리기 횟수(${limits.USER_MAX_PER_MONTH}회)를 모두 썼습니다. 다음 달에 다시 올릴 수 있어요.` };
  if (global) {
    const full = global.limitBytes > 0 && global.bytes + size > global.limitBytes * limits.STORAGE_BLOCK_RATIO;
    const busy = global.opsLimit > 0 && global.opsMonthCount >= global.opsLimit * limits.OPS_BLOCK_RATIO;
    if (full || busy) return { status: 503, message: '사진 저장소가 거의 가득 차서 잠시 업로드를 막았습니다. 관리자에게 알려 주세요.' };
  }
  return null;
}

export function storageLimitBytes(env = process.env) {
  const mb = Number(env.UPLOAD_STORAGE_LIMIT_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : UPLOAD_LIMITS.DEFAULT_STORAGE_LIMIT_MB) * 1024 * 1024;
}

/**
 * Blob 열쇠(토큰)를 찾는다. 기본 이름은 BLOB_READ_WRITE_TOKEN 이지만,
 * Vercel에서 스토어를 연결할 때 "접두어(Prefix)"를 바꾸면 이름이 MYSTORE_READ_WRITE_TOKEN 처럼 달라진다.
 * 그래서 이름이 _READ_WRITE_TOKEN 으로 끝나는 변수도 찾아 준다. 없으면 undefined.
 */
export function findBlobToken(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN) return env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(env).find((name) => /_READ_WRITE_TOKEN$/.test(name) && env[name]);
  return key ? env[key] : undefined;
}

/**
 * Blob에 접속할 방법이 있는지 본다.
 * (1) 열쇠 방식: BLOB_READ_WRITE_TOKEN (또는 *_READ_WRITE_TOKEN)
 * (2) OIDC 방식: Vercel이 BLOB_STORE_ID 만 주고, 인증은 @vercel/blob 이 알아서 한다. (새 스토어의 기본값)
 */
export function hasBlobAuth(env = process.env) {
  return Boolean(findBlobToken(env) || env.BLOB_STORE_ID);
}

/** put/del/list 에 넘길 인증 옵션. 열쇠가 있으면 { token }, OIDC 방식이면 {} (SDK가 환경 변수로 알아서 인증) */
export function blobAuthOptions(env = process.env) {
  const token = findBlobToken(env);
  return token ? { token } : {};
}

export function monthlyOpsLimit(env = process.env) {
  const n = Number(env.UPLOAD_MONTHLY_OPS_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : UPLOAD_LIMITS.DEFAULT_MONTHLY_OPS_LIMIT;
}

/**
 * 라우터에 사진 업로드 주소들을 붙인다.
 * deps: { router, requireAuth, requireAdmin, writeLimiter, getDb, isAdminId, HttpError, wrap, FieldValue }
 * options.blob: 테스트에서 가짜 Blob({ put, del, list })을 넣는 자리. 평소에는 @vercel/blob 을 필요할 때 불러온다.
 */
export function registerUploadRoutes(deps, options = {}) {
  const { router, requireAuth, requireAdmin, writeLimiter, getDb, isAdminId, HttpError, wrap, FieldValue } = deps;
  const getBlob = async () => options.blob ?? (await import('@vercel/blob'));

  const userRaw = express.raw({ type: ['image/webp', 'image/jpeg', 'image/png'], limit: UPLOAD_LIMITS.USER_MAX_FILE_BYTES });
  const adminRaw = express.raw({ type: ['image/webp', 'image/jpeg', 'image/png'], limit: UPLOAD_LIMITS.ADMIN_MAX_FILE_BYTES });

  // 관리자냐 아니냐에 따라 받아주는 크기를 다르게 한다. 너무 크면 친절한 문구로 거절.
  const readImageBody = (req, res, next) => {
    const parser = isAdminId(req.user.id) ? adminRaw : userRaw;
    parser(req, res, (err) => {
      if (err?.type === 'entity.too.large') return res.status(413).json({ error: '사진이 너무 큽니다. 더 작은 사진을 올려 주세요.' });
      next(err);
    });
  };

  const usageOf = (snap, isAdmin) => ({
    isAdmin,
    bytes: Number(snap?.get?.('uploadBytes')) || 0,
    count: Number(snap?.get?.('uploadCount')) || 0,
    monthCount: snap?.get?.('uploadMonth') === monthKey() ? Number(snap?.get?.('uploadMonthCount')) || 0 : 0, // 이번 달에 올린 횟수
    maxPerMonth: isAdmin ? null : UPLOAD_LIMITS.USER_MAX_PER_MONTH,
    maxBytes: isAdmin ? null : UPLOAD_LIMITS.USER_MAX_TOTAL_BYTES, // null = 제한 없음
    maxFiles: isAdmin ? null : UPLOAD_LIMITS.USER_MAX_FILES,
    maxFileBytes: isAdmin ? UPLOAD_LIMITS.ADMIN_MAX_FILE_BYTES : UPLOAD_LIMITS.USER_MAX_FILE_BYTES,
  });

  const bumpStats = (db, writer, bytes, count) =>
    writer.set(
      db.collection(COL_META).doc(STATS_ID),
      { bytes: FieldValue.increment(bytes), count: FieldValue.increment(count), updatedAt: Date.now() },
      { merge: true }
    );

  // 내 사용량 (사진 올리기 화면이 처음 열릴 때 부른다)
  router.get('/api/uploads/mine', requireAuth, wrap(async (req, res) => {
    const isAdmin = isAdminId(req.user.id);
    const snap = await getDb().collection(COL_USERS).doc(req.user.id).get();
    res.json({ usage: usageOf(snap, isAdmin) });
  }));

  // 내 사진 보관함: 최근 순으로 최대 100장 (다시 쓰거나 지울 때 쓴다)
  router.get('/api/uploads/mine/items', requireAuth, wrap(async (req, res) => {
    const snap = await getDb().collection(COL_UPLOADS).where('userId', '==', req.user.id).limit(100).get();
    const items = snap.docs
      .map((d) => ({ id: d.id, url: d.get('url'), size: Number(d.get('size')) || 0, createdAt: Number(d.get('createdAt')) || 0 }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ items });
  }));

  // 안 쓰는 사진 찾기: 내 모든 스토리의 장면(게시본 + 초안)을 훑어서, 어디에도 안 쓰이는 사진만 돌려준다.
  // 지우는 건 하지 않는다. (화면에서 고른 사진만 DELETE /api/uploads/:id 로 지운다)
  router.get('/api/uploads/mine/unused', requireAuth, wrap(async (req, res) => {
    const db = getDb();
    const userId = req.user.id;
    const [uploadsSnap, storiesSnap] = await Promise.all([
      db.collection(COL_UPLOADS).where('userId', '==', userId).limit(100).get(),
      db.collection(COL_STORIES).where('authorId', '==', userId).get(),
    ]);
    // 읽기 전에 스토리 문서에 적힌 장면 수로 대략의 양을 가늠해서, 너무 많으면 거절한다.
    const estimate = storiesSnap.docs.reduce((sum, d) => sum + (Number(d.get('sceneCount')) || 0) + (Number(d.get('draftSceneCount')) || 0), 0);
    if (estimate > UNUSED_SCAN_MAX_SCENES) throw new HttpError(413, '스토리가 너무 많아서 한 번에 확인할 수 없어요. 안 쓰는 스토리를 정리한 뒤 다시 시도해 주세요.');

    const used = new Set();
    let scenesScanned = 0;
    for (const story of storiesSnap.docs) {
      for (const sub of [COL_SCENES, COL_DRAFT_SCENES]) {
        const snap = await story.ref.collection(sub).select('imageUrl').get();
        scenesScanned += snap.size;
        for (const doc of snap.docs) {
          const url = doc.get('imageUrl');
          if (typeof url === 'string' && url) used.add(url);
        }
      }
    }
    const cutoff = Date.now() - UNUSED_GRACE_MS;
    const total = uploadsSnap.size;
    const unused = uploadsSnap.docs
      .map((d) => ({ id: d.id, url: d.get('url'), size: Number(d.get('size')) || 0, createdAt: Number(d.get('createdAt')) || 0 }))
      .filter((item) => item.url && !used.has(item.url) && item.createdAt < cutoff)
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ unused, total, scanned: { stories: storiesSnap.size, scenes: scenesScanned } });
  }));

  // 사진 올리기: 본문이 사진 파일 그대로다. (Content-Type: image/webp 등)
  router.post('/api/uploads', requireAuth, writeLimiter, readImageBody, wrap(async (req, res) => {
    if (!hasBlobAuth()) {
      console.error('[uploads] Blob 연결 정보가 없습니다. (BLOB_READ_WRITE_TOKEN 도 BLOB_STORE_ID 도 없음) Vercel Storage에서 Blob을 이 프로젝트에 연결하고 재배포하세요.');
      throw new HttpError(503, '사진 저장소가 아직 준비되지 않았습니다.');
    }
    const isAdmin = isAdminId(req.user.id);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(415, 'webp, jpeg, png 사진만 올릴 수 있습니다.');
    const mime = sniffImage(buf);
    const declared = String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!mime || mime !== declared) throw new HttpError(415, '올바른 사진 파일이 아닙니다.');

    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(req.user.id);
    const size = buf.length;

    // 1) 먼저 "자리 예약". 동시에 여러 장을 올려도 한도를 못 넘게 트랜잭션으로 확인한다.
    const month = monthKey();
    const statsRef = db.collection(COL_META).doc(STATS_ID);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const statsSnap = await tx.get(statsRef);
      const usage = usageOf(snap, isAdmin);
      const global = {
        bytes: Math.max(0, Number(statsSnap.get?.('bytes')) || 0),
        limitBytes: storageLimitBytes(),
        opsMonthCount: statsSnap.get?.('opsMonth') === month ? Number(statsSnap.get?.('opsMonthCount')) || 0 : 0,
        opsLimit: monthlyOpsLimit(),
      };
      const problem = checkQuota({ usage, size, isAdmin, global });
      if (problem) throw new HttpError(problem.status, problem.message, { usage });
      tx.set(userRef, { uploadBytes: FieldValue.increment(size), uploadCount: FieldValue.increment(1), uploadMonth: month, uploadMonthCount: usage.monthCount + 1 }, { merge: true });
      tx.set(statsRef, { opsMonth: month, opsMonthCount: global.opsMonthCount + 1 }, { merge: true });
    });

    // 2) 실제 저장. 실패하면 예약을 되돌린다.
    const id = randomUUID();
    const pathname = `${BLOB_PREFIX}/${req.user.id}/${id}.${EXT[mime]}`;
    let blobResult;
    try {
      const { put } = await getBlob();
      blobResult = await put(pathname, buf, { access: 'public', contentType: mime, addRandomSuffix: false, cacheControlMaxAge: 60 * 60 * 24 * 30, ...blobAuthOptions() });
    } catch (err) {
      console.error('[uploads] Blob 저장 실패', err);
      await userRef.set({ uploadBytes: FieldValue.increment(-size), uploadCount: FieldValue.increment(-1), uploadMonthCount: FieldValue.increment(-1) }, { merge: true }).catch(() => {});
      await statsRef.set({ opsMonthCount: FieldValue.increment(-1) }, { merge: true }).catch(() => {});
      throw new HttpError(502, '사진 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }

    // 3) 기록 남기기 (실패해도 사진은 이미 저장됨. 관리자 화면의 "다시 계산"으로 바로잡을 수 있다)
    try {
      const batch = db.batch();
      batch.set(db.collection(COL_UPLOADS).doc(id), {
        userId: req.user.id, url: blobResult.url, pathname, size, contentType: mime, createdAt: Date.now(),
      });
      bumpStats(db, batch, size, 1);
      await batch.commit();
    } catch (err) {
      console.error('[uploads] 기록 저장 실패 (사진은 저장됨)', err);
    }

    const after = await userRef.get();
    res.status(201).json({ id, url: blobResult.url, size, usage: usageOf(after, isAdmin) });
  }));

  // 사진 지우기: 올린 본인 또는 관리자
  router.delete('/api/uploads/:id', requireAuth, writeLimiter, wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UPLOAD_ID_PATTERN.test(id)) throw new HttpError(404, '사진을 찾을 수 없습니다.');
    const db = getDb();
    const ref = db.collection(COL_UPLOADS).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, '사진을 찾을 수 없습니다.');
    const ownerId = String(snap.get('userId'));
    if (ownerId !== req.user.id && !isAdminId(req.user.id)) throw new HttpError(404, '사진을 찾을 수 없습니다.');
    const size = Number(snap.get('size')) || 0;
    try {
      const { del } = await getBlob();
      await del(String(snap.get('url')), blobAuthOptions());
    } catch (err) {
      console.error('[uploads] Blob 삭제 실패', err);
      throw new HttpError(502, '사진 삭제에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
    const batch = db.batch();
    batch.delete(ref);
    batch.set(db.collection(COL_USERS).doc(ownerId), { uploadBytes: FieldValue.increment(-size), uploadCount: FieldValue.increment(-1) }, { merge: true });
    bumpStats(db, batch, -size, -1);
    await batch.commit();
    res.json({ ok: true });
  }));

  // ───────────── 관리자 전용 ─────────────

  // 사용량 보기. 화면이 5초마다 부른다. (읽는 문서: 합계 1 + 상위 유저 10 + 최근 사진 8)
  router.get('/api/admin/upload-stats', requireAdmin, wrap(async (req, res) => {
    const db = getDb();
    const [statsSnap, topSnap, recentSnap] = await Promise.all([
      db.collection(COL_META).doc(STATS_ID).get(),
      db.collection(COL_USERS).orderBy('uploadBytes', 'desc').limit(10).get(),
      db.collection(COL_UPLOADS).orderBy('createdAt', 'desc').limit(8).get(),
    ]);
    const totalBytes = Math.max(0, Number(statsSnap.get?.('bytes')) || 0);
    res.json({
      totalBytes,
      totalCount: Math.max(0, Number(statsSnap.get?.('count')) || 0),
      limitBytes: storageLimitBytes(),
      opsMonthCount: statsSnap.get?.('opsMonth') === monthKey() ? Math.max(0, Number(statsSnap.get?.('opsMonthCount')) || 0) : 0,
      opsLimit: monthlyOpsLimit(),
      syncedAt: Number(statsSnap.get?.('syncedAt')) || null,
      serverTime: Date.now(),
      topUsers: topSnap.docs
        .map((d) => ({ id: d.id, username: d.get('username') ?? null, bytes: Number(d.get('uploadBytes')) || 0, count: Number(d.get('uploadCount')) || 0 }))
        .filter((u) => u.bytes > 0),
      recent: recentSnap.docs.map((d) => ({ id: d.id, userId: d.get('userId'), size: Number(d.get('size')) || 0, url: d.get('url'), createdAt: Number(d.get('createdAt')) || 0 })),
    });
  }));

  // "다시 계산": Vercel Blob에 실제로 있는 파일을 세어서 전체 합계를 바로잡는다. (유저별 숫자는 그대로)
  router.post('/api/admin/upload-stats/resync', requireAdmin, writeLimiter, wrap(async (req, res) => {
    const { list } = await getBlob();
    let bytes = 0;
    let count = 0;
    let cursor;
    for (let page = 0; page < 50; page += 1) { // 최대 5만 장까지만 (무한 반복 방지)
      const result = await list({ prefix: `${BLOB_PREFIX}/`, limit: 1000, cursor, ...blobAuthOptions() });
      for (const blob of result.blobs) { bytes += Number(blob.size) || 0; count += 1; }
      if (!result.hasMore) break;
      cursor = result.cursor;
    }
    await getDb().collection(COL_META).doc(STATS_ID).set({ bytes, count, updatedAt: Date.now(), syncedAt: Date.now() }, { merge: true }); // 이번 달 횟수는 그대로 둔다
    res.json({ ok: true, totalBytes: bytes, totalCount: count });
  }));
}
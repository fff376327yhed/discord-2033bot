// 활동 로그 + 보안 이벤트 + 운영자 전용 "전체 유저 관리" API
//
// ■ 무엇을 하나
//  1) 로그인한 유저가 "글을 바꾸는 요청"(스토리 저장/삭제, 사진 올리기, 신고, 운영자 조치 등)을 성공하면
//     users/{유저ID}/activity/{시각_난수} 에 한 줄 기록한다. (유저별 활동 로그)
//  2) 수상한 요청(속도제한 429, 차단된 요청 403, 로그인 없이 쓰기 401, 운영자 아닌 사람의 운영자 주소 접근)은
//     securityEvents/{시각_난수} 에 기록한다. (보안 로그)
//  3) 한 사람이 10분 안에 수상한 요청을 10번 하면 users/{ID}.suspiciousAt 에 표시한다. (자동 차단은 하지 않음 - 오탐 방지)
//  4) 운영자 전용 API: 유저 목록/검색, 유저 상세, 유저별 활동 로그, 보안 로그, 강제 로그아웃, 의심 표시 해제
//
// ■ 안전 원칙
//  - 요청 본문(body), 쿠키, 토큰은 절대 기록하지 않는다. 정해 둔 항목(제목, true/false 등)만 골라서 기록한다.
//  - IP는 원문을 저장하지 않는다. "마지막 자리를 가린 값(예: 203.0.113.x)"과 "같은 IP끼리 묶어 보기용 짧은 해시"만 저장한다.
//  - 기록이 실패해도 서비스는 멈추지 않는다. (오류는 서버 로그에 1분에 한 번만 남긴다)
//  - 이 파일은 bundle.js 를 import 하지 않는다. (서로 빙글빙글 불러오는 문제 방지) 필요한 도구는 인자로 받는다.
//
// ■ 보관 기간
//  expireAt 필드를 넣어 두었다. Firestore 콘솔에서 TTL 정책을 켜면 자동으로 지워진다. (README/답변의 "1회 설정" 참고)
//  TTL을 켜지 않아도 동작은 하지만 기록이 계속 쌓인다.

import { createHmac, randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';

export const ACTIVITY = {
  SUB: 'activity',                 // users/{ID}/activity (하위 컬렉션)
  SECURITY_COL: 'securityEvents',  // 최상위 컬렉션
  RETENTION_DAYS: 90,              // 유저 활동 로그 보관 (TTL 정책 켰을 때)
  SECURITY_RETENTION_DAYS: 30,     // 보안 로그 보관
  PAGE: 50,                        // 로그 한 번에 보여줄 개수
  USERS_PAGE: 30,                  // 유저 목록 한 번에 보여줄 개수
  SEEN_THROTTLE_MS: 10 * 60_000,   // "마지막 접속" 갱신은 같은 서버에서 10분에 한 번만 (Firestore 쓰기 절약)
  WRITE_TIMEOUT_MS: 1500,          // 로그를 쓰느라 응답을 늦추는 최대 시간
  SECURITY_THROTTLE_MS: 10_000,    // 같은 사람의 같은 보안 이벤트는 10초에 한 번만 기록 (도배 공격으로 쓰기 비용이 폭주하는 것 방지)
  DUP_THROTTLE_MS: 30_000,         // 같은 스토리 저장 로그는 30초에 한 번만
  // 의심 점수: 10분 안에 점수가 쌓이면 표시/자동 차단한다.
  //  - 우리 사이트가 아닌 곳에서 보낸 쓰기 요청(Origin/CSRF 403), 일반 유저의 운영자 주소 접근: 1건당 5점 (정상 사용에서는 거의 생기지 않음)
  //  - 속도 제한(429): 1건당 1점
  SUSPICIOUS_FLAG_SCORE: 5,        // 이 점수가 되면 🚩 의심 표시
  SUSPICIOUS_BLOCK_SCORE: 10,      // 이 점수가 되면 자동 차단 (운영자는 제외, 환경 변수 AUTO_BLOCK=off 로 끌 수 있음)
  SUSPICIOUS_WINDOW_MS: 10 * 60_000,
  MAX_META_KEYS: 6,
  MAX_META_LEN: 100,
  CACHE_MAX: 3000,                 // 메모리에 기억해 둘 항목 수 상한 (메모리 폭주 방지)
};

const ID_PATTERN = /^\d{5,25}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g; // 제어문자, 글자 방향 뒤집기 문자 제거

const clean = (value, max) => String(value ?? '').replace(CONTROL_CHARS, ' ').slice(0, max);

// ═════════════════════════════════════════════
// 요청에서 "누가/어디서" 뽑는 도구들
// ═════════════════════════════════════════════

/** 접속 IP. Vercel이 붙여 주는 헤더를 먼저 믿는다. (로컬에서는 소켓 주소) */
export function clientIp(req) {
  const h = req.headers ?? {};
  const raw =
    h['x-vercel-forwarded-for'] ||
    h['x-real-ip'] ||
    String(h['x-forwarded-for'] ?? '').split(',')[0] ||
    req.socket?.remoteAddress ||
    '';
  return clean(String(raw).trim(), 64);
}

/** IP 마지막 자리를 가린다. 203.0.113.45 → 203.0.113.x */
export function maskIp(ip) {
  if (!ip) return '';
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.x`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::x`;
  return '';
}

// 같은 IP끼리 묶어 보기 위한 짧은 해시. JWT_SECRET 으로 섞어서(HMAC) 해시만으로는 원래 IP를 알아낼 수 없다.
function hashIp(ip) {
  const secret = process.env.JWT_SECRET;
  if (!ip || !secret) return '';
  return createHmac('sha256', secret).update(`ip:${ip}`).digest('hex').slice(0, 12);
}

/** User-Agent 원문 대신 "Chrome · Windows" 같은 요약만 저장한다. */
export function deviceLabel(ua) {
  const s = String(ua ?? '');
  const os = /Windows/i.test(s) ? 'Windows'
    : /Android/i.test(s) ? 'Android'
      : /iPhone|iPad|iOS/i.test(s) ? 'iOS'
        : /Mac OS X|Macintosh/i.test(s) ? 'Mac'
          : /Linux/i.test(s) ? 'Linux' : '';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /Firefox\//.test(s) ? 'Firefox'
        : /Chrome\//.test(s) ? 'Chrome'
          : /Safari\//.test(s) ? 'Safari'
            : /discord/i.test(s) ? 'Discord' : '';
  return [browser, os].filter(Boolean).join(' · ') || '알 수 없음';
}

/** 기록에 넣을 부가 정보를 정리한다. 이름이 안전하고 값이 글자/숫자/true·false 인 것만 최대 6개. */
function cleanMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const [key, value] of Object.entries(meta).slice(0, ACTIVITY.MAX_META_KEYS)) {
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = clean(value, ACTIVITY.MAX_META_LEN);
  }
  return out;
}

/** 로그 문서 ID: 시각(13자리) + 난수. 문서 ID 순서가 곧 시간 순서라서 별도 인덱스 없이 최신순으로 읽을 수 있다. */
const newLogId = (ts) => `${String(ts).padStart(13, '0')}_${randomBytes(3).toString('hex')}`;

/**
 * 요청 경로 → [기록 종류, 화면에 보일 이름]. null 이면 기록하지 않는다.
 * 목록에 없는 쓰기 요청은 'other.메서드' 로 기록한다. (빠뜨린 요청도 흔적은 남기기 위해)
 */
const ROUTE_LABELS = {
  'POST /api/stories': ['story.create', '스토리 만들기'],
  'PUT /api/stories/:id': ['story.update', '스토리 정보 저장'],
  'PUT /api/stories/:id/scenes': ['story.scenes', '장면 저장'],
  'PUT /api/stories/:id/draft': ['story.draft', '초안 저장'],
  'POST /api/stories/:id/draft/publish': ['story.publish', '초안 게시'],
  'DELETE /api/stories/:id/draft': ['story.draft_discard', '초안 버리기'],
  'PATCH /api/stories/:id/visibility': ['story.visibility', '공개/비공개 전환'],
  'DELETE /api/stories/:id': ['story.delete', '스토리 삭제'],
  'PUT /api/stories/:id/like': ['social.like', '좋아요 변경'],
  'POST /api/stories/:id/report': ['social.report', '스토리 신고'],
  'POST /api/uploads': ['upload.add', '사진 올리기'],
  'DELETE /api/uploads/:id': ['upload.delete', '사진 지우기'],
  'PUT /api/admin/reports/:reportId': ['admin.report', '신고 처리'],
  'PUT /api/admin/stories/:id/hidden': ['admin.hide', '스토리 숨김/해제'],
  'PUT /api/admin/users/:userId/blocked': ['admin.block', '유저 차단/해제'],
  'POST /api/admin/users/:userId/revoke': ['admin.revoke', '유저 강제 로그아웃'],
  'POST /api/admin/users/:userId/clear-flag': ['admin.clear_flag', '의심 표시 해제'],
  'POST /api/admin/upload-stats/resync': ['admin.resync', '저장소 합계 다시 계산'],
  'POST /api/validate': null,        // 검사만 하는 요청이라 기록하지 않음
  'POST /api/auth/logout': null,     // 로그아웃은 라우트 안에서 직접 기록한다
};

// 종류 → 이름 (직접 기록하는 것들)
const LABEL_BY_TYPE = {
  'auth.login': '로그인',
  'auth.logout': '로그아웃',
  'auth.login_blocked': '차단된 계정의 로그인 시도',
  'admin.on_me': '운영자 조치',
  'security.rate_limited': '요청이 너무 많음 (속도 제한)',
  'security.forbidden': '차단된 요청 (403)',
  'security.unauthorized': '로그인 없이 쓰기 시도 (401)',
  'security.admin_probe': '운영자 주소에 일반 유저가 접근',
  'security.auth_state': '로그인 확인값 불일치 (가짜 로그인 의심)',
  'security.auto_flag': '자동 의심 표시',
  'security.auto_block': '자동 차단 (해킹 시도 의심)',
};

// 같은 요청이 연달아 오면 한 번만 기록할 종류 (저장 버튼 한 번에 요청이 두 개 가는 경우 등)
const DUP_TYPES = new Set(['story.update', 'story.scenes', 'story.draft']);

// ═════════════════════════════════════════════
// 기록기
// ═════════════════════════════════════════════

/**
 * @param {object} deps  getDb, isAdminId, COL(컬렉션 이름표) 를 bundle.js 에서 넘겨받는다.
 *                       (FieldValue 는 지금은 쓰지 않지만 받아 둔다)
 */
export function createActivityLogger({ getDb, isAdminId = () => false, COL = { USERS: 'users' }, sessionStore = null, now = () => Date.now() } = {}) {
  const seenAt = new Map();    // userId → 마지막으로 "마지막 접속"을 쓴 시각
  const dupAt = new Map();     // 중복 방지 키 → 시각
  const secAt = new Map();     // 보안 이벤트 도배 방지 키 → 시각
  const flagWindow = new Map(); // userId → 최근 수상한 요청 시각들

  const enabled = () => process.env.ACTIVITY_LOG !== 'off'; // 급할 때 끄는 스위치
  const remember = (map, key, value) => {
    if (map.size >= ACTIVITY.CACHE_MAX) map.clear(); // 가득 차면 통째로 비운다 (단순하고 안전)
    map.set(key, value);
  };

  let lastErrorAt = 0;
  function reportError(err) {
    const t = now();
    if (t - lastErrorAt < 60_000) return; // 1분에 한 번만
    lastErrorAt = t;
    console.error('[activity] 기록 실패 (서비스에는 영향 없음)', err?.message ?? err);
  }

  function describe(req) {
    const ip = clientIp(req);
    return { ip: maskIp(ip), ipHash: hashIp(ip), device: deviceLabel(req.headers?.['user-agent']) };
  }

  /** 유저 한 명의 활동 한 줄을 기록한다. 성공하면 true. 절대 예외를 던지지 않는다. */
  async function log(userId, type, meta = {}, req = null, opts = {}) {
    if (!enabled() || !ID_PATTERN.test(String(userId))) return false;
    try {
      const ts = now();
      const doc = {
        ts,
        type,
        label: opts.label ?? LABEL_BY_TYPE[type] ?? type,
        ok: opts.ok !== false,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.actorId ? { actorId: String(opts.actorId) } : {}),
        ...(req ? describe(req) : {}),
        meta: cleanMeta(meta),
        expireAt: new Date(ts + ACTIVITY.RETENTION_DAYS * 86_400_000),
      };
      await getDb().collection(COL.USERS).doc(String(userId)).collection(ACTIVITY.SUB).doc(newLogId(ts)).set(doc);
      return true;
    } catch (err) {
      reportError(err);
      return false;
    }
  }

  /** 수상한 일을 보안 로그에 기록한다. userId 는 모르면 null. */
  async function logSecurity(type, meta = {}, req = null, { userId = null, status = 0, weight = 0 } = {}) {
    if (!enabled()) return false;
    try {
      const uid = userId && ID_PATTERN.test(String(userId)) ? String(userId) : null;
      const t = now();
      const who = req ? describe(req) : { ip: '', ipHash: '', device: '' };

      // 의심 표시용 횟수는 도배 방지(아래 throttle)보다 먼저 센다. 도배하는 사람일수록 빨리 걸려야 하니까.
      if (uid && weight > 0) await noteSuspicious(uid, type, t, weight);

      const key = `${who.ipHash || '-'}:${type}:${uid ?? ''}`;
      if (t - (secAt.get(key) ?? 0) < ACTIVITY.SECURITY_THROTTLE_MS) return false;
      remember(secAt, key, t);

      await getDb().collection(ACTIVITY.SECURITY_COL).doc(newLogId(t)).set({
        ts: t,
        type,
        label: LABEL_BY_TYPE[type] ?? type,
        userId: uid,
        status: Number(status) || 0,
        ...who,
        meta: cleanMeta(meta),
        expireAt: new Date(t + ACTIVITY.SECURITY_RETENTION_DAYS * 86_400_000),
      });
      return true;
    } catch (err) {
      reportError(err);
      return false;
    }
  }

  // 10분 안의 의심 점수를 더한다. 5점이면 🚩 표시, 10점이면 자동 차단.
  // 운영자는 차단하지 않고 표시만 한다. (실수로 운영자가 잠기는 것 방지)
  async function noteSuspicious(userId, type, t, weight) {
    const list = (flagWindow.get(userId) ?? []).filter((x) => t - x.t < ACTIVITY.SUSPICIOUS_WINDOW_MS);
    const before = list.reduce((sum, x) => sum + x.w, 0);
    list.push({ t, w: weight });
    remember(flagWindow, userId, list);
    const after = before + weight;
    const reason = clean(`${LABEL_BY_TYPE[type] ?? type}`, 60);

    const crossedBlock = before < ACTIVITY.SUSPICIOUS_BLOCK_SCORE && after >= ACTIVITY.SUSPICIOUS_BLOCK_SCORE;
    const crossedFlag = before < ACTIVITY.SUSPICIOUS_FLAG_SCORE && after >= ACTIVITY.SUSPICIOUS_FLAG_SCORE;
    if (!crossedBlock && !crossedFlag) return;

    const canBlock = crossedBlock && sessionStore && process.env.AUTO_BLOCK !== 'off' && !isAdminId(userId);
    if (canBlock) {
      // 차단하면 기존 로그인도 모두 끊긴다. (sessionStore.setBlocked 가 sessionsValidAfter 를 올린다)
      await sessionStore.setBlocked(userId, true, { reason: `자동 차단: ${reason}`, now: t });
      await getDb().collection(COL.USERS).doc(userId).set({ autoBlocked: true, suspiciousAt: t, suspiciousReason: reason }, { merge: true });
    } else {
      await getDb().collection(COL.USERS).doc(userId).set({ suspiciousAt: t, suspiciousReason: reason }, { merge: true });
    }
    await getDb().collection(ACTIVITY.SECURITY_COL).doc(newLogId(t)).set({
      ts: t,
      type: canBlock ? 'security.auto_block' : 'security.auto_flag',
      label: LABEL_BY_TYPE[canBlock ? 'security.auto_block' : 'security.auto_flag'],
      userId,
      status: 0,
      ip: '',
      ipHash: '',
      device: '',
      meta: cleanMeta({ trigger: type, score: after }),
      expireAt: new Date(t + ACTIVITY.SECURITY_RETENTION_DAYS * 86_400_000),
    });
  }

  /** "마지막 접속" 시각 갱신. 같은 서버에서는 10분에 한 번만 쓴다. */
  async function touchSeen(userId) {
    if (!enabled() || !ID_PATTERN.test(String(userId))) return;
    const t = now();
    if (t - (seenAt.get(userId) ?? 0) < ACTIVITY.SEEN_THROTTLE_MS) return;
    remember(seenAt, userId, t);
    try {
      await getDb().collection(COL.USERS).doc(userId).set({ lastSeenAt: t }, { merge: true });
    } catch (err) {
      reportError(err);
    }
  }

  // 요청 하나를 보고 "무엇을 기록할지" 정한다. 기록할 것이 없으면 null.
  function buildJob(req, res) {
    if (!enabled()) return null;
    const status = res.statusCode;
    const method = req.method;
    const user = req.user ?? null;
    const url = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    const routeKey = req.route && typeof req.route.path === 'string' ? `${method} ${req.baseUrl ?? ''}${req.route.path}` : null;
    const shownPath = clean(routeKey ? routeKey.slice(method.length + 1) : url, 80);
    const note = typeof res.locals?.auditNote === 'string' ? res.locals.auditNote : '';
    const jobs = [];

    // 1) 보안 이벤트 (weight = 의심 점수)
    if (status === 429) {
      jobs.push(logSecurity('security.rate_limited', { path: shownPath }, req, { userId: user?.id, status, weight: 1 }));
    } else if (status === 403 && note) {
      // note 가 있는 403 = 우리 코드가 "가짜 출처/헤더 없음"으로 막은 것. (업로드 용량 초과 같은 정상적인 403 은 기록하지 않는다)
      jobs.push(logSecurity('security.forbidden', { path: shownPath, reason: note }, req, { userId: user?.id, status, weight: 5 }));
    } else if (status === 401 && method !== 'GET' && method !== 'HEAD') {
      jobs.push(logSecurity('security.unauthorized', { path: shownPath }, req, { status }));
    } else if (status === 404 && url.startsWith('/api/admin') && user && !isAdminId(user.id)) {
      jobs.push(logSecurity('security.admin_probe', { path: clean(url, 80) }, req, { userId: user.id, status, weight: 5 }));
    }

    // 2) 유저 활동 (로그인한 사람의 쓰기 요청이 성공했을 때만)
    if (user && !['GET', 'HEAD', 'OPTIONS'].includes(method) && status < 400 && routeKey) {
      const known = Object.hasOwn(ROUTE_LABELS, routeKey);
      const entry = known ? ROUTE_LABELS[routeKey] : [`other.${method.toLowerCase()}`, routeKey];
      if (entry) {
        const [type, label] = entry;
        const t = now();
        const dupKey = `${user.id}:${type}:${req.params?.id ?? ''}`;
        const skip = DUP_TYPES.has(type) && t - (dupAt.get(dupKey) ?? 0) < ACTIVITY.DUP_THROTTLE_MS;
        if (!skip) {
          if (DUP_TYPES.has(type)) remember(dupAt, dupKey, t);
          const meta = routeMeta(req, type);
          jobs.push(log(user.id, type, meta, req, { label, status }));
          // 운영자가 다른 유저에게 한 조치는 그 유저의 기록에도 남긴다. (유저 상세에서 "누가 무슨 조치를 했는지" 보이게)
          const target = req.params?.userId;
          if (type.startsWith('admin.') && target && String(target) !== user.id) {
            jobs.push(log(String(target), 'admin.on_me', { action: type, by: user.id, ...pickBodyFlags(req, type) }, req, { label: `운영자 조치: ${label}`, actorId: user.id, status }));
          }
        }
      }
    }
    return jobs.length ? Promise.all(jobs) : null;
  }

  // 기록에 넣어도 되는 요청 정보만 골라낸다. body 전체는 절대 넣지 않는다.
  function pickBodyFlags(req, type) {
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const out = {};
    if (type === 'story.visibility' && typeof b.isPublic === 'boolean') out.isPublic = b.isPublic;
    if (type === 'social.like' && typeof b.liked === 'boolean') out.liked = b.liked;
    if (type === 'social.report' && typeof b.reason === 'string') out.reason = clean(b.reason, 20);
    if (type === 'admin.hide' && typeof b.hidden === 'boolean') out.hidden = b.hidden;
    if (type === 'admin.block' && typeof b.blocked === 'boolean') out.blocked = b.blocked;
    if ((type === 'admin.hide' || type === 'admin.block') && typeof b.reason === 'string') out.reason = clean(b.reason, 100);
    if (type === 'admin.report' && typeof b.status === 'string') out.status = clean(b.status, 20);
    if ((type === 'story.create' || type === 'story.update') && typeof b.title === 'string') out.title = clean(b.title, 50);
    return out;
  }

  function routeMeta(req, type) {
    const p = req.params ?? {};
    const meta = {};
    if (p.id) meta[type.startsWith('upload.') ? 'uploadId' : 'storyId'] = clean(p.id, 64);
    if (p.userId) meta.targetUser = clean(p.userId, 25);
    if (p.reportId) meta.reportId = clean(p.reportId, 90);
    return { ...meta, ...pickBodyFlags(req, type) };
  }

  /**
   * Express 미들웨어. 응답을 끝내기 직전에 기록을 먼저 보내고(최대 1.5초) 응답을 끝낸다.
   * 이유: Vercel 서버리스는 응답이 끝나면 함수가 바로 멈출 수 있어서, 그 뒤에 쓰려던 기록이 사라질 수 있다.
   */
  function auditMiddleware() {
    return (req, res, next) => {
      const originalEnd = res.end;
      let done = false;
      res.end = function patchedEnd(...args) {
        if (done) return originalEnd.apply(this, args);
        done = true;
        let job = null;
        try {
          job = buildJob(req, res);
        } catch (err) {
          reportError(err);
        }
        if (!job) return originalEnd.apply(this, args);
        const self = this;
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ACTIVITY.WRITE_TIMEOUT_MS); });
        Promise.race([job.catch(reportError), timeout]).then(() => {
          clearTimeout(timer);
          originalEnd.apply(self, args);
        });
        return this;
      };
      next();
    };
  }

  return { log, logSecurity, touchSeen, auditMiddleware };
}

/** 아무것도 기록하지 않는 가짜 기록기 (테스트용) */
export function createNoopActivityLogger() {
  return {
    log: async () => false,
    logSecurity: async () => false,
    touchSeen: async () => {},
    auditMiddleware: () => (req, res, next) => next(),
  };
}

// ═════════════════════════════════════════════
// 출처(Origin) 검사: CSRF 3번째 방어선
// ═════════════════════════════════════════════
// 이미 있는 방어: SameSite=Lax 쿠키 + 'x-requested-with' 헤더. 여기에 "요청을 보낸 사이트 주소"까지 확인한다.
// 브라우저는 글을 바꾸는 요청에 Origin 헤더를 자동으로 붙이고, 자바스크립트로 속일 수 없다.
// 허용: ① 요청을 받은 서버 자기 자신(Host 와 같은 주소) ② SITE_URL ③ ALLOWED_ORIGINS(쉼표로 구분, 선택) ④ 개발 중 localhost
// Origin 헤더가 아예 없으면(일부 오래된 요청) 통과시킨다. 그래도 위의 두 방어선이 남아 있다.

export function isAllowedOrigin(req, env = process.env) {
  const origin = typeof req.get === 'function' ? req.get('origin') : req.headers?.origin;
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // 'null' 같은 이상한 값
  }
  const host = (typeof req.get === 'function' ? req.get('x-forwarded-host') || req.get('host') : req.headers?.host) || '';
  if (host && parsed.host === host) return true; // 같은 사이트에서 보낸 요청

  const allowed = new Set();
  try { allowed.add(new URL(env.SITE_URL || 'http://localhost:3000').origin); } catch { /* 무시 */ }
  for (const item of String(env.ALLOWED_ORIGINS ?? '').split(',')) {
    try { if (item.trim()) allowed.add(new URL(item.trim()).origin); } catch { /* 무시 */ }
  }
  if (!String(env.SITE_URL ?? '').startsWith('https://')) {
    for (const port of [3000, 5173]) { // 개발 중에만 (SITE_URL 이 https 가 아닐 때)
      allowed.add(`http://localhost:${port}`);
      allowed.add(`http://127.0.0.1:${port}`);
    }
  }
  return allowed.has(parsed.origin);
}

// ═════════════════════════════════════════════
// 운영자 전용 API
// ═════════════════════════════════════════════

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 개수 세기. 오래된 firebase-admin 이라 count()가 없으면 null (화면에서는 "-" 로 보인다). */
async function countOf(query) {
  try {
    return (await query.count().get()).data().count;
  } catch {
    return null;
  }
}

export function registerAdminUserRoutes({ router, requireAdmin, writeLimiter, getDb, isAdminId, HttpError, wrap, sessionStore, COL }) {
  // 운영자 조회 요청도 1분 120회로 제한한다. (운영자 계정이 털려도 한꺼번에 긁어 가기 어렵게)
  const readLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `admin-read:${req.user?.id ?? 'anon'}`,
  });

  const requireUserId = (req) => {
    const id = String(req.params.userId ?? '');
    if (!ID_PATTERN.test(id)) throw new HttpError(400, '올바르지 않은 사용자 ID입니다.');
    return id;
  };

  // 화면에 내려주는 유저 정보. 서버 내부 값(sessionsValidAfter 등)은 빼고 필요한 것만 고른다.
  const pickUser = (id, d) => ({
    id,
    username: d.username ?? null,
    avatar: d.avatar ?? null,
    createdAt: Number(d.createdAt) || 0,
    updatedAt: Number(d.updatedAt) || 0,
    lastSeenAt: Number(d.lastSeenAt) || 0,
    lastLoginAt: Number(d.lastLoginAt) || 0,
    loginCount: Number(d.loginCount) || 0,
    blocked: d.blocked === true,
    autoBlocked: d.blocked === true && d.autoBlocked === true,
    blockedAt: Number(d.blockedAt) || 0,
    blockedReason: String(d.blockedReason ?? ''),
    suspiciousAt: Number(d.suspiciousAt) || 0,
    suspiciousReason: String(d.suspiciousReason ?? ''),
    isAdmin: isAdminId(id),
  });

  const pickLog = (doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ts: Number(d.ts) || 0,
      type: String(d.type ?? ''),
      label: String(d.label ?? d.type ?? ''),
      ok: d.ok !== false,
      status: Number(d.status) || 0,
      ip: String(d.ip ?? ''),
      ipHash: String(d.ipHash ?? ''),
      device: String(d.device ?? ''),
      actorId: d.actorId ? String(d.actorId) : null,
      userId: d.userId ? String(d.userId) : null,
      meta: d.meta && typeof d.meta === 'object' ? d.meta : {},
    };
  };

  // 전체 유저 목록 / 검색
  //   ?sort=joined(가입 최신순, 기본) | seen(최근 접속순)   ?q=이름 앞부분 또는 디스코드 ID   ?cursor=다음 페이지 값
  // 최근 접속순은 이 기능을 켠 뒤 접속한 유저부터 나온다. (이전 접속 기록은 없으므로)
  router.get(
    '/api/admin/users',
    requireAdmin,
    readLimiter,
    wrap(async (req, res) => {
      const db = getDb();
      const col = db.collection(COL.USERS);
      const q = clean(typeof req.query.q === 'string' ? req.query.q : '', 40).trim();
      const sortField = req.query.sort === 'seen' ? 'lastSeenAt' : 'createdAt';
      const limit = clampInt(req.query.limit, 1, 50, ACTIVITY.USERS_PAGE);

      if (q) {
        let docs;
        if (ID_PATTERN.test(q)) {
          const snap = await col.doc(q).get();
          docs = snap.exists ? [snap] : [];
        } else {
          // 이름 앞부분 검색 (대소문자 구분). Firestore 는 "포함" 검색이 안 돼서 앞부분만 찾는다.
          docs = (await col.where('username', '>=', q).where('username', '<=', `${q}\uf8ff`).limit(limit).get()).docs;
        }
        return res.json({ users: docs.map((doc) => pickUser(doc.id, doc.data())), nextCursor: null, stats: null });
      }

      let query = col.orderBy(sortField, 'desc');
      const hasCursor = req.query.cursor !== undefined && req.query.cursor !== '';
      if (hasCursor) {
        const cursor = Number(req.query.cursor);
        if (!Number.isFinite(cursor)) throw new HttpError(400, 'cursor 값이 올바르지 않습니다.');
        query = query.startAfter(cursor);
      }
      const snap = await query.limit(limit + 1).get();
      const page = snap.docs.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = snap.docs.length > limit && last ? String(Number(last.get(sortField)) || 0) : null;

      // 첫 페이지일 때만 위쪽 숫자 카드를 계산한다. (읽기 비용 절약)
      let stats = null;
      if (!hasCursor) {
        const t = Date.now();
        const [total, newToday, newWeek, seenToday, blocked] = await Promise.all([
          countOf(col),
          countOf(col.where('createdAt', '>=', t - 86_400_000)),
          countOf(col.where('createdAt', '>=', t - 7 * 86_400_000)),
          countOf(col.where('lastSeenAt', '>=', t - 86_400_000)),
          countOf(col.where('blocked', '==', true)),
        ]);
        stats = { total, newToday, newWeek, seenToday, blocked };
      }
      res.json({ users: page.map((doc) => pickUser(doc.id, doc.data())), nextCursor, stats });
    })
  );

  // 유저 상세: 프로필 + 스토리 개수
  router.get(
    '/api/admin/users/:userId',
    requireAdmin,
    readLimiter,
    wrap(async (req, res) => {
      const id = requireUserId(req);
      const db = getDb();
      const snap = await db.collection(COL.USERS).doc(id).get();
      if (!snap.exists) throw new HttpError(404, '유저를 찾을 수 없습니다.');
      const stories = db.collection(COL.STORIES).where('authorId', '==', id);
      const [storyCount, publicStoryCount] = await Promise.all([countOf(stories), countOf(stories.where('isPublic', '==', true))]);
      res.json({ user: pickUser(id, snap.data()), storyCount, publicStoryCount });
    })
  );

  // 유저별 활동 로그 (최신순). ?cursor=이전 응답의 nextCursor
  router.get(
    '/api/admin/users/:userId/activity',
    requireAdmin,
    readLimiter,
    wrap(async (req, res) => {
      const id = requireUserId(req);
      const limit = clampInt(req.query.limit, 1, 100, ACTIVITY.PAGE);
      let query = getDb().collection(COL.USERS).doc(id).collection(ACTIVITY.SUB).orderBy('ts', 'desc');
      if (/^\d{10,15}$/.test(String(req.query.cursor ?? ''))) query = query.startAfter(Number(req.query.cursor));
      const snap = await query.limit(limit + 1).get();
      const page = snap.docs.slice(0, limit);
      res.json({ items: page.map(pickLog), nextCursor: snap.docs.length > limit ? String(page[page.length - 1].get('ts')) : null });
    })
  );

  // 보안 로그 (최신순). 로그인 안 한 사람의 수상한 요청도 여기에 모인다.
  router.get(
    '/api/admin/security-events',
    requireAdmin,
    readLimiter,
    wrap(async (req, res) => {
      const db = getDb();
      const limit = clampInt(req.query.limit, 1, 100, ACTIVITY.PAGE);
      console.log('[admin] 보안 로그 조회'); // 오류가 나면 바로 아래에서 원인이 함께 찍힌다
      let query = db.collection(ACTIVITY.SECURITY_COL).orderBy('ts', 'desc');
      if (/^\d{10,15}$/.test(String(req.query.cursor ?? ''))) query = query.startAfter(Number(req.query.cursor));
      const snap = await query.limit(limit + 1).get();
      const page = snap.docs.slice(0, limit);
      const items = page.map(pickLog);

      // 이름/아바타를 함께 보여주려고 관련 유저 프로필을 한꺼번에 읽는다.
      const ids = [...new Set(items.map((i) => i.userId).filter(Boolean))];
      const profiles = {};
      if (ids.length) {
        const docs = await db.getAll(...ids.map((uid) => db.collection(COL.USERS).doc(uid)));
        for (const doc of docs) profiles[doc.id] = { id: doc.id, username: doc.get('username') ?? null, avatar: doc.get('avatar') ?? null };
      }
      res.json({
        items: items.map((i) => ({ ...i, user: i.userId ? profiles[i.userId] ?? { id: i.userId, username: null, avatar: null } : null })),
        nextCursor: snap.docs.length > limit ? String(page[page.length - 1].get('ts')) : null,
      });
    })
  );

  // 강제 로그아웃: 그 유저의 모든 로그인 토큰을 지금 시각으로 무효화한다. (차단과 달리 다시 로그인은 할 수 있다)
  router.post(
    '/api/admin/users/:userId/revoke',
    requireAdmin,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireUserId(req);
      await sessionStore.revoke(id);
      res.json({ ok: true });
    })
  );

  // 자동 "의심" 표시를 운영자가 확인한 뒤 지운다.
  router.post(
    '/api/admin/users/:userId/clear-flag',
    requireAdmin,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireUserId(req);
      const ref = getDb().collection(COL.USERS).doc(id);
      if (!(await ref.get()).exists) throw new HttpError(404, '유저를 찾을 수 없습니다.');
      await ref.set({ suspiciousAt: 0, suspiciousReason: '' }, { merge: true });
      res.json({ ok: true });
    })
  );
}

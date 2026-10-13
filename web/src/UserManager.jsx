// 관리자 탭: "전체 유저"(누가 들어왔는지, 유저별 활동 로그) + "보안 로그"(수상한 요청 모음)
// 서버가 ADMIN_DISCORD_IDS 로 다시 확인하므로, 운영자가 아니면 이 화면의 요청은 모두 404 로 막힌다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, avatarUrl } from './lib.js';
import './admin-users.css';

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR') : '-');

function ago(ms) {
  if (!ms) return '기록 없음';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return fmt(ms);
}

const num = (n) => (n === null || n === undefined ? '-' : n.toLocaleString('ko-KR'));

function Avatar({ user, size = 32 }) {
  return (
    <img
      className="um-avatar"
      src={avatarUrl({ id: user.id, avatar: user.avatar }, 64)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

// 기록 한 줄의 부가 정보를 "이름: 값" 조각으로 보여준다.
const META_NAMES = {
  storyId: '스토리', uploadId: '사진', targetUser: '대상 유저', reportId: '신고', title: '제목',
  isPublic: '공개', liked: '좋아요', hidden: '숨김', blocked: '차단', reason: '사유', status: '상태',
  firstTime: '첫 가입', action: '조치', by: '운영자', path: '주소', trigger: '원인',
};

function MetaChips({ meta }) {
  const entries = Object.entries(meta ?? {});
  if (!entries.length) return null;
  return (
    <span className="um-meta">
      {entries.map(([k, v]) => (
        <span key={k} className="um-chip" title={String(v)}>
          {META_NAMES[k] ?? k}: {typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v).length > 22 ? `${String(v).slice(0, 22)}…` : String(v)}
        </span>
      ))}
    </span>
  );
}

function IpText({ item }) {
  if (!item.ip && !item.ipHash) return <span className="muted">-</span>;
  return (
    <span title="마지막 자리는 가려서 저장합니다. 같은 #값이면 같은 IP입니다.">
      {item.ip || '-'} {item.ipHash && <span className="muted">#{item.ipHash.slice(0, 6)}</span>}
    </span>
  );
}

/* ───────────────────────── 유저별 활동 로그 ───────────────────────── */

const LOG_FILTERS = [
  ['all', '전체'],
  ['auth', '로그인'],
  ['story', '스토리'],
  ['upload', '사진'],
  ['social', '좋아요/신고'],
  ['admin', '운영자 조치'],
  ['other', '기타'],
];

function ActivityLog({ userId }) {
  const [items, setItems] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const alive = useRef(true);

  const load = useCallback(async (cursor) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.adminUserActivity(userId, cursor);
      if (!alive.current) return;
      setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
      setNext(data.nextCursor ?? null);
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    alive.current = true;
    load(null);
    return () => { alive.current = false; };
  }, [load]);

  const shown = items.filter((i) => filter === 'all' || i.type.split('.')[0] === filter || (filter === 'other' && !LOG_FILTERS.some(([k]) => k === i.type.split('.')[0])));

  return (
    <div className="um-log">
      <div className="um-log-head">
        <strong>활동 로그</strong>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {LOG_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button type="button" className="btn btn-small" disabled={loading} onClick={() => load(null)}>새로고침</button>
      </div>
      {error && <div className="validation-error hint">⚠️ {error}</div>}
      {!error && !loading && items.length === 0 && <div className="hint">아직 기록이 없어요. (이 기능을 켠 뒤의 활동만 기록됩니다)</div>}
      {shown.map((i) => (
        <div key={i.id} className={`um-log-row ${i.ok ? '' : 'fail'}`}>
          <div className="um-log-main">
            <span className="um-log-label">{i.ok ? '' : '⚠️ '}{i.label}</span>
            <MetaChips meta={i.meta} />
          </div>
          <div className="um-log-sub">
            {fmt(i.ts)} · {i.device || '-'} · <IpText item={i} />
            {i.actorId && <> · 운영자 {i.actorId}</>}
          </div>
        </div>
      ))}
      {loading && <div className="hint">불러오는 중...</div>}
      {next && !loading && <button type="button" className="btn btn-small" onClick={() => load(next)}>더 보기</button>}
    </div>
  );
}

/* ───────────────────────── 유저 상세 ───────────────────────── */

function UserDetail({ id, onClose, onShowStories, onChanged }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('');

  const reload = useCallback(async () => {
    try {
      setInfo(await api.adminUser(id));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => { setInfo(null); setBlocking(false); setReason(''); reload(); }, [reload]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function doBlock(blocked) {
    await run(() => api.adminBlockUser(id, blocked, reason.trim()));
    setBlocking(false);
    setReason('');
  }

  function doRevoke() {
    if (!window.confirm('이 유저를 모든 기기에서 로그아웃시킵니다. (다시 로그인은 할 수 있어요) 계속할까요?')) return;
    run(() => api.adminRevokeUser(id));
  }

  const u = info?.user;

  return (
    <div className="card um-detail">
      <div className="card-head um-detail-head">
        <strong>유저 상세</strong>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={onClose}>닫기</button>
      </div>

      {error && <div className="validation-error hint">⚠️ {error}</div>}
      {!u && !error && <div className="hint">불러오는 중...</div>}

      {u && (
        <>
          <div className="um-profile">
            <Avatar user={u} size={48} />
            <div>
              <div>
                <a href={`https://discord.com/users/${u.id}`} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                  <strong>{u.username || '(이름 모름)'}</strong>
                </a>{' '}
                <span className="muted">({u.id})</span>{' '}
                {u.isAdmin && <span className="badge">운영자</span>}{' '}
                {u.blocked && <span className="badge um-bad">차단됨{u.autoBlocked ? ' (자동)' : ''}</span>}{' '}
                {u.suspiciousAt > 0 && <span className="badge um-warn" title={u.suspiciousReason}>🚩 의심</span>}
              </div>
              <div className="meta">
                가입 {fmt(u.createdAt)} · 마지막 접속 {u.lastSeenAt ? `${fmt(u.lastSeenAt)} (${ago(u.lastSeenAt)})` : '기록 없음'} · 로그인 {num(u.loginCount)}회
              </div>
              <div className="meta">
                스토리 {num(info.storyCount)}개 (공개 {num(info.publicStoryCount)}개)
              </div>
              {u.blocked && (
                <div className="meta">차단 {fmt(u.blockedAt)}{u.blockedReason && ` · 사유: ${u.blockedReason}`}</div>
              )}
              {u.suspiciousAt > 0 && (
                <div className="meta">의심 표시 {fmt(u.suspiciousAt)} · {u.suspiciousReason}</div>
              )}
            </div>
          </div>

          <div className="um-actions">
            <button type="button" className="btn btn-small" onClick={() => onShowStories(u.id)}>이 유저의 스토리 보기</button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={doRevoke}>강제 로그아웃</button>
            {u.suspiciousAt > 0 && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => api.adminClearFlag(u.id))}>의심 표시 해제</button>
            )}
            {u.blocked ? (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => doBlock(false)}>차단 해제</button>
            ) : (
              !u.isAdmin && !blocking && <button type="button" className="btn btn-small btn-danger-outline" onClick={() => setBlocking(true)}>차단하기</button>
            )}
          </div>

          {blocking && !u.blocked && (
            <div className="um-block-box">
              <div>{u.username || u.id} 님을 차단합니다. 바로 로그아웃되고, 다시 로그인하거나 봇을 플레이할 수 없습니다.</div>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 (선택, 100자 이내)" maxLength={100} style={{ width: '100%', marginTop: 6 }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => doBlock(true)}>차단 확인</button>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => setBlocking(false)}>취소</button>
              </div>
            </div>
          )}

          <ActivityLog key={u.id} userId={u.id} />
        </>
      )}
    </div>
  );
}

/* ───────────────────────── 전체 유저 목록 ───────────────────────── */

export default function UserManager({ onShowStories }) {
  const [users, setUsers] = useState(null);
  const [stats, setStats] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState('joined'); // 'joined' | 'seen'
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const detailRef = useRef(null);
  const alive = useRef(true);

  const load = useCallback(async (cursor) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sort });
      if (q) params.set('q', q);
      if (cursor) params.set('cursor', cursor);
      const data = await api.adminUsers(params.toString());
      if (!alive.current) return;
      setUsers((prev) => (cursor && prev ? [...prev, ...data.users] : data.users));
      setNext(data.nextCursor ?? null);
      if (data.stats) setStats(data.stats);
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [sort, q]);

  useEffect(() => {
    alive.current = true;
    setUsers(null);
    load(null);
    return () => { alive.current = false; };
  }, [load]);

  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);

  function search() {
    setQ(input.trim());
  }

  return (
    <div className="um-wrap">
      {stats && (
        <div className="um-stats">
          <div className="um-stat"><div className="um-stat-n">{num(stats.total)}</div><div className="um-stat-l">전체 유저</div></div>
          <div className="um-stat"><div className="um-stat-n">{num(stats.newToday)}</div><div className="um-stat-l">오늘 가입</div></div>
          <div className="um-stat"><div className="um-stat-n">{num(stats.newWeek)}</div><div className="um-stat-l">7일 내 가입</div></div>
          <div className="um-stat"><div className="um-stat-n">{num(stats.seenToday)}</div><div className="um-stat-l">오늘 접속</div></div>
          <div className="um-stat"><div className="um-stat-n">{num(stats.blocked)}</div><div className="um-stat-l">차단</div></div>
        </div>
      )}

      <div className="um-controls">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          placeholder="이름 앞부분 또는 디스코드 ID로 찾기"
          maxLength={40}
        />
        <button type="button" className="btn btn-small" onClick={search}>검색</button>
        {q && <button type="button" className="btn btn-small" onClick={() => { setInput(''); setQ(''); }}>전체 보기</button>}
        <select value={sort} onChange={(e) => setSort(e.target.value)} disabled={Boolean(q)} title="검색 중에는 정렬을 바꿀 수 없어요">
          <option value="joined">가입 최신순</option>
          <option value="seen">최근 접속순</option>
        </select>
      </div>
      {sort === 'seen' && !q && <div className="hint">최근 접속순은 이 기능을 켠 뒤 접속한 유저부터 보입니다. 모든 유저를 보려면 가입순을 쓰세요.</div>}

      {selected && (
        <div ref={detailRef}>
          <UserDetail
            key={selected}
            id={selected}
            onClose={() => setSelected(null)}
            onShowStories={onShowStories}
            onChanged={() => load(null)}
          />
        </div>
      )}

      {error && <div>⚠️ {error}</div>}
      {!error && !users && <div>불러오는 중...</div>}
      {users?.length === 0 && <p className="muted">{q ? '찾는 유저가 없습니다.' : '유저가 없습니다.'}</p>}

      {users?.map((u) => (
        <div key={u.id} className={`story-row um-row ${selected === u.id ? 'selected' : ''}`} onClick={() => setSelected(u.id)}>
          <div className="um-row-main">
            <Avatar user={u} />
            <div style={{ minWidth: 0 }}>
              <div className="um-name">
                <strong>{u.username || '(이름 모름)'}</strong> <span className="muted">({u.id})</span>{' '}
                {u.isAdmin && <span className="badge">운영자</span>}{' '}
                {u.blocked && <span className="badge um-bad">차단됨{u.autoBlocked ? ' (자동)' : ''}</span>}{' '}
                {u.suspiciousAt > 0 && <span className="badge um-warn">🚩 의심</span>}
              </div>
              <div className="meta">
                가입 {fmt(u.createdAt)} · 마지막 접속 {u.lastSeenAt ? ago(u.lastSeenAt) : u.updatedAt ? `${ago(u.updatedAt)} (활동 기준)` : '기록 없음'} · 로그인 {num(u.loginCount)}회
              </div>
            </div>
          </div>
        </div>
      ))}

      {next && !loading && <button type="button" className="btn btn-small" onClick={() => load(next)}>더 보기</button>}
      {loading && users && <div className="hint">불러오는 중...</div>}
    </div>
  );
}

/* ───────────────────────── 보안 로그 ───────────────────────── */

export function SecurityLog() {
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async (cursor) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.adminSecurityEvents(cursor);
      if (!alive.current) return;
      setItems((prev) => (cursor && prev ? [...prev, ...data.items] : data.items));
      setNext(data.nextCursor ?? null);
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // 로그인 안 한 접속(IP)의 임시 차단 목록
  const [blocks, setBlocks] = useState([]);
  const [blockError, setBlockError] = useState(null);
  const loadBlocks = useCallback(async () => {
    try {
      const data = await api.adminIpBlocks();
      if (alive.current) { setBlocks(data.items); setBlockError(null); }
    } catch (err) {
      if (alive.current) setBlockError(err.message);
    }
  }, []);
  async function unblock(b) {
    if (!window.confirm(`${b.ip || '이 접속'}의 임시 차단을 지금 풀까요?`)) return;
    try {
      await api.adminUnblockIp(b.ipHash);
      await loadBlocks();
    } catch (err) {
      setBlockError(err.message);
    }
  }

  useEffect(() => {
    alive.current = true;
    load(null);
    loadBlocks();
    return () => { alive.current = false; };
  }, [load, loadBlocks]);

  return (
    <div className="um-wrap">
      <div className="hint">
        로그인 확인값 불일치, 차단된 요청(403), 속도 제한(429), 로그인 없는 쓰기 시도, 운영자 주소에 접근한 일반 유저가 기록됩니다.
        의심 점수가 10분 안에 5점이 되면 🚩 의심 표시, 10점이 되면 자동 차단됩니다. (가짜 출처 요청·운영자 주소 접근 = 5점, 속도 제한 = 1점. 운영자는 차단되지 않음)
        잘못 차단됐다면 "전체 유저"에서 해당 유저를 열어 차단 해제하세요.
        로그인 안 한 접속은 계정이 없으므로 IP 로 막습니다: 10분 안에 15점이 쌓이면 30분 동안 로그인 없는 요청만 제한되고(로그인한 사람은 영향 없음), 아래 목록에서 바로 풀 수 있습니다.
      </div>

      {blockError && <div>⚠️ {blockError}</div>}
      {blocks.length > 0 && (
        <div className="card soft">
          <strong>🚫 임시 차단 중인 접속 (로그인 안 한 사람)</strong>
          {blocks.map((b) => (
            <div key={b.ipHash} className="um-log-row sec">
              <div className="um-log-main">
                <span className="um-log-label">{b.ip || b.ipHash}</span>
                <span className="muted"> {b.reason} · {b.score}점</span>
              </div>
              <div className="um-log-sub">
                {fmt(b.blockedAt)} 차단 · {fmt(b.until)} 에 자동으로 풀림{' '}
                <button type="button" className="btn btn-small" onClick={() => unblock(b)}>지금 풀기</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div><button type="button" className="btn btn-small" disabled={loading} onClick={() => { load(null); loadBlocks(); }}>새로고침</button></div>

      {error && <div>⚠️ {error}</div>}
      {!error && !items && <div>불러오는 중...</div>}
      {items?.length === 0 && <p className="muted">기록된 보안 이벤트가 없습니다. 👍</p>}

      {items?.map((i) => (
        <div key={i.id} className="um-log-row sec">
          <div className="um-log-main">
            <span className="um-log-label">{i.label}</span>
            <MetaChips meta={i.meta} />
          </div>
          <div className="um-log-sub">
            {fmt(i.ts)} · {i.user ? <><Avatar user={i.user} size={16} /> {i.user.username || i.user.id}</> : '로그인 안 한 사람'} · {i.device || '-'} · <IpText item={i} />
            {i.status > 0 && <> · HTTP {i.status}</>}
          </div>
        </div>
      ))}

      {next && !loading && <button type="button" className="btn btn-small" onClick={() => load(next)}>더 보기</button>}
      {loading && items && <div className="hint">불러오는 중...</div>}
    </div>
  );
}

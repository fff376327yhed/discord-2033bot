// 앱 화면: 로그인 → 내 스토리 목록 → 편집기 (+ 운영자라면 관리자 탭)
// 예전의 Login.jsx, StoryList.jsx 를 이 파일 안으로 합쳤다.
import { useEffect, useState } from 'react';
import { api, avatarUrl } from './lib.js';
import Editor from './Editor.jsx';
import StorageMonitor from './StorageMonitor.jsx';
import UserManager, { SecurityLog } from './UserManager.jsx';

/* ───────────────────────── Login ───────────────────────── */

function Login() {
  return (
    <div className="center-screen">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <h1>🚇 서울 2033 창작마당</h1>
        <p style={{ color: 'var(--muted)' }}>디스코드로 로그인하면 내 스토리를 만들고 편집할 수 있습니다.</p>
        <a className="btn btn-primary" href="/api/auth/login" style={{ display: 'inline-block', marginTop: 12 }}>
          디스코드로 로그인
        </a>
      </div>
    </div>
  );
}

/* ───────────────────────── StoryList (내 스토리) ───────────────────────── */

function StoryList({ onOpen }) {
  const [stories, setStories] = useState(null);
  const [error, setError] = useState(null);

  function reload() {
    api.myStories().then((data) => setStories(data.stories)).catch((err) => setError(err.message));
  }
  useEffect(reload, []);

  async function createStory() {
    try {
      const data = await api.createStory({ title: '새 스토리' });
      onOpen(data.story.id);
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <div className="story-list">⚠️ {error}</div>;
  if (!stories) return <div className="story-list">불러오는 중...</div>;

  return (
    <div className="story-list">
      <button className="btn btn-primary" onClick={createStory}>+ 새 스토리 만들기</button>
      {stories.length === 0 && <p style={{ color: 'var(--muted)' }}>아직 만든 스토리가 없습니다.</p>}
      {stories.map((story) => (
        <div key={story.id} className="story-row" onClick={() => onOpen(story.id)}>
          <div>
            <div>
              {story.title} {story.isPublic ? <span className="badge">공개</span> : <span className="badge">비공개</span>}
            </div>
            <div className="meta">
              장면 {story.sceneCount}개 · 플레이 {story.playCount}회 ·{' '}
              {story.tags.map((t) => <span key={t} className="tag-pill">{t}</span>)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── AdminPanel (관리자) ───────────────────────── */

// 서버 MODERATION.REASONS 와 같은 표 (reason 은 코드로 내려온다)
const REASON_LABELS = {
  spam: '스팸/광고',
  offensive: '불쾌하거나 부적절한 내용',
  copyright: '저작권 침해',
  other: '기타',
};

const STATUS_LABELS = {
  open: '대기',
  resolved: '처리됨',
  dismissed: '기각',
  stories: '전체 스토리',
  hidden: '숨긴 스토리',
  blocked: '차단한 사용자',
  users: '전체 유저',
  security: '보안 로그',
};

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR') : '-');

// 디스코드 계정 표시: 아바타 + 이름 + (ID). 이름을 누르면 디스코드 프로필이 새 탭으로 열린다.
// user 는 서버가 내려주는 { id, username, avatar }. users 문서가 없는 사람은 이름이 null 이라 ID만 보인다.
function UserBadge({ user, id }) {
  const userId = String(user?.id ?? id ?? '');
  const name = user?.username || '(이름 모름)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
      <img
        src={avatarUrl({ id: userId, avatar: user?.avatar }, 32)}
        alt=""
        width={20}
        height={20}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ borderRadius: '50%' }}
      />
      <a href={`https://discord.com/users/${userId}`} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
        {name}
      </a>
      <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>({userId})</span>
    </span>
  );
}

function AdminPanel({ onOpen }) {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // 신고 카드의 확인창: { kind: 'hide' | 'block' | 'delete', report }
  const [storyAction, setStoryAction] = useState(null); // 스토리 카드의 확인창: { kind: 'hide' | 'delete', story }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [authorInput, setAuthorInput] = useState('');
  const [authorId, setAuthorId] = useState(''); // 전체 스토리 탭에서 이 작성자만 보기

  function reload() {
    setError(null);
    setReports(null);
    // 전체 유저/보안 로그 탭은 아래의 별도 화면(UserManager/SecurityLog)이 직접 불러온다.
    if (status === 'users' || status === 'security') {
      setReports([]);
      return;
    }
    const request = status === 'stories'
      ? api.adminStories(authorId).then((data) => data.stories)
      : status === 'hidden'
        ? api.adminHiddenStories().then((data) => data.stories)
        : status === 'blocked'
          ? api.adminBlockedUsers().then((data) => data.users)
          : api.adminReports(status).then((data) => data.reports);
    request
      .then((list) => setReports(list ?? []))
      .catch((err) => setError(err.message));
  }
  useEffect(reload, [status, authorId]);

  async function act(fn) {
    setBusy(true);
    try {
      await fn();
      setPending(null);
      setStoryAction(null);
      setReason('');
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openConfirm(kind, report) {
    setStoryAction(null);
    setPending({ kind, report });
    setReason('');
  }

  function openStoryConfirm(kind, story) {
    setPending(null);
    setStoryAction({ kind, story });
    setReason('');
  }

  // 숨김/차단/삭제가 성공하면 이 신고도 자동으로 '처리 완료'로 넘긴다.
  function confirm() {
    const { kind, report } = pending;
    act(async () => {
      if (kind === 'hide') await api.adminHideStory(report.storyId, true, reason.trim());
      else if (kind === 'delete') await api.deleteStory(report.storyId);
      else await api.adminBlockUser(report.authorId, true, reason.trim());
      await api.adminResolveReport(report.id, 'resolved');
    });
  }

  // 스토리 카드(전체 스토리 / 숨긴 스토리 탭)의 숨기기·삭제 확인
  function confirmStory() {
    const { kind, story } = storyAction;
    act(async () => {
      if (kind === 'delete') await api.deleteStory(story.id);
      else await api.adminHideStory(story.id, true, reason.trim());
    });
  }

  function unhide(story) {
    act(() => api.adminHideStory(story.id, false, ''));
  }

  function unblock(user) {
    act(() => api.adminBlockUser(user.id, false, ''));
  }

  function applyAuthorFilter() {
    const value = authorInput.trim();
    if (value !== '' && !/^\d{5,25}$/.test(value)) {
      setError('작성자 ID는 숫자(디스코드 사용자 ID)로 입력하세요.');
      return;
    }
    setAuthorId(value);
  }

  // 전체 스토리 / 숨긴 스토리 탭에서 쓰는 스토리 카드
  function renderStory(story) {
    const acting = storyAction?.story.id === story.id ? storyAction : null;
    const title = story.title || '(제목 없음)';
    return (
      <div key={story.id} className="story-row" style={{ cursor: 'default' }}>
        <div style={{ width: '100%' }}>
          <div>
            {title}{' '}
            <span className="badge">{story.isPublic ? '공개' : '비공개'}</span>{' '}
            {story.hidden && <span className="badge">숨김</span>}
          </div>
          <div className="meta">
            작성자 <UserBadge user={story.author} id={story.authorId} /> · 장면 {story.sceneCount}개 · 플레이 {story.playCount}회 · 수정 {fmt(story.updatedAt)}
          </div>
          {(story.hiddenReason || story.hiddenAt > 0) && (
            <div className="meta">
              숨김 {fmt(story.hiddenAt)}{story.hiddenReason && <> · 사유: {story.hiddenReason}</>}
            </div>
          )}
          {!acting && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-small btn-primary" disabled={busy} onClick={() => onOpen(story.id)}>편집</button>
              {story.hidden
                ? <button className="btn btn-small" disabled={busy} onClick={() => unhide(story)}>숨김 해제</button>
                : <button className="btn btn-small" disabled={busy} onClick={() => openStoryConfirm('hide', story)}>숨기기</button>}
              <button className="btn btn-small" disabled={busy} onClick={() => openStoryConfirm('delete', story)}>삭제</button>
              {status === 'stories' && (
                <button
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => { setAuthorInput(story.authorId); setAuthorId(story.authorId); }}
                >
                  이 작성자 스토리만
                </button>
              )}
            </div>
          )}
          {acting && (
            <div style={{ marginTop: 8 }}>
              <div>
                {acting.kind === 'delete'
                  ? `「${title}」을(를) 삭제합니다. 장면·플레이 기록·좋아요가 모두 지워지고 되돌릴 수 없습니다.`
                  : `「${title}」을(를) 숨깁니다.`}
              </div>
              {acting.kind === 'hide' && (
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="사유 (선택, 100자 이내)"
                  maxLength={100}
                  style={{ width: '100%', marginTop: 6 }}
                />
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="btn btn-small btn-primary" disabled={busy} onClick={confirmStory}>
                  {acting.kind === 'delete' ? '삭제 확인' : '확인'}
                </button>
                <button className="btn btn-small" disabled={busy} onClick={() => setStoryAction(null)}>취소</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isStoryTab = status === 'stories' || status === 'hidden';
  const isUserTab = status === 'users' || status === 'security';

  // 유저 상세의 "스토리 보기" → 전체 스토리 탭에서 그 작성자만 보여준다.
  function showStoriesOf(userId) {
    setAuthorInput(userId);
    setAuthorId(userId);
    setStatus('stories');
  }
  const isReportTab = status === 'open' || status === 'resolved' || status === 'dismissed';

  return (
    <div className="story-list">
      <StorageMonitor />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {Object.keys(STATUS_LABELS).map((s) => (
          <button
            key={s}
            className={`btn btn-small ${status === s ? 'btn-primary' : ''}`}
            onClick={() => setStatus(s)}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {status === 'stories' && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={authorInput}
            onChange={(e) => setAuthorInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyAuthorFilter(); }}
            placeholder="작성자 디스코드 ID로 찾기 (비우면 최근 수정순 50개)"
            style={{ flex: 1 }}
          />
          <button className="btn btn-small" onClick={applyAuthorFilter}>조회</button>
          {authorId && (
            <button className="btn btn-small" onClick={() => { setAuthorInput(''); setAuthorId(''); }}>전체 보기</button>
          )}
        </div>
      )}

      {error && <div>⚠️ {error}</div>}
      {!error && !reports && <div>불러오는 중...</div>}
      {!isUserTab && reports?.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>
          {isStoryTab ? '스토리가 없습니다.' : status === 'blocked' ? '차단한 사용자가 없습니다.' : '신고가 없습니다.'}
        </p>
      )}

      {status === 'users' && <UserManager onShowStories={showStoriesOf} />}
      {status === 'security' && <SecurityLog />}

      {isStoryTab && reports?.map(renderStory)}

      {status === 'blocked' && reports?.map((u) => (
        <div key={u.id} className="story-row" style={{ cursor: 'default' }}>
          <div style={{ width: '100%' }}>
            <div><UserBadge user={u} id={u.id} /></div>
            <div className="meta">
              {u.blockedReason && <>{u.blockedReason} · </>}
              {fmt(u.blockedAt)}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-small" disabled={busy} onClick={() => unblock(u)}>차단 해제</button>
            </div>
          </div>
        </div>
      ))}

      {isReportTab && reports?.map((r) => {
        const isPending = pending?.report.id === r.id;
        const authorName = r.author?.username || r.authorId;
        return (
          <div key={r.id} className="story-row" style={{ cursor: 'default' }}>
            <div style={{ width: '100%' }}>
              <div>
                {r.storyTitle || '(제목 없음)'} <span className="badge">{REASON_LABELS[r.reason] ?? r.reason}</span>
              </div>
              <div className="meta">
                작성자 <UserBadge user={r.author} id={r.authorId} />
              </div>
              <div className="meta">
                신고자 <UserBadge user={r.reporter} id={r.userId} />
              </div>
              <div className="meta">
                {r.detail && <>{r.detail} · </>}
                {fmt(r.createdAt)} · 스토리 {r.storyId}
              </div>
              {r.handledAt > 0 && (
                <div className="meta">
                  {r.status === 'dismissed' ? '기각' : '처리'} {fmt(r.handledAt)}
                  {r.handledBy && <> · 처리자 {r.handledBy}</>}
                </div>
              )}
              {status === 'open' && !isPending && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-small" disabled={busy} onClick={() => onOpen(r.storyId)}>스토리 보기/편집</button>
                  <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.adminResolveReport(r.id, 'resolved'))}>처리 완료</button>
                  <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.adminResolveReport(r.id, 'dismissed'))}>기각</button>
                  <button className="btn btn-small" onClick={() => openConfirm('hide', r)}>스토리 숨기기</button>
                  <button className="btn btn-small" onClick={() => openConfirm('delete', r)}>스토리 삭제</button>
                  <button className="btn btn-small" onClick={() => openConfirm('block', r)}>작성자 차단</button>
                </div>
              )}
              {isPending && (
                <div style={{ marginTop: 8 }}>
                  <div>
                    {pending.kind === 'hide' && `「${r.storyTitle || r.storyId}」을(를) 숨깁니다.`}
                    {pending.kind === 'delete' && `「${r.storyTitle || r.storyId}」을(를) 삭제합니다. 장면·플레이 기록·좋아요가 모두 지워지고 되돌릴 수 없습니다.`}
                    {pending.kind === 'block' && `작성자 ${authorName}(${r.authorId})을(를) 차단합니다.`}
                  </div>
                  {pending.kind !== 'delete' && (
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="사유 (선택, 100자 이내)"
                      maxLength={100}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button className="btn btn-small btn-primary" disabled={busy} onClick={confirm}>
                      {pending.kind === 'delete' ? '삭제 확인' : '확인'}
                    </button>
                    <button className="btn btn-small" disabled={busy} onClick={() => setPending(null)}>취소</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── App ───────────────────────── */

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = 확인 중, null = 비로그인
  const [storyId, setStoryId] = useState(null);
  const [tab, setTab] = useState('stories'); // 'stories' | 'admin'
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    api.me()
      .then((data) => {
        setUser(data.user);
        setIsAdmin(Boolean(data.isAdmin)); // 탭 노출용일 뿐, 진짜 권한 확인은 서버가 한다
      })
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div style={{ padding: 20 }}>불러오는 중...</div>;
  }

  if (!user) {
    return <Login />;
  }

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setTab('stories');
      setIsAdmin(false);
      setUser(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <strong>🚇 서울 2033 창작마당</strong>
        {isAdmin && !storyId && (
          <>
            <button className={`btn btn-small ${tab === 'stories' ? 'btn-primary' : ''}`} onClick={() => setTab('stories')}>내 스토리</button>
            <button className={`btn btn-small ${tab === 'admin' ? 'btn-primary' : ''}`} onClick={() => setTab('admin')}>관리자</button>
          </>
        )}
        <div className="spacer" />
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          title={`디스코드 계정: ${user.username ?? user.name ?? '이름 모름'} (${user.id ?? '-'})`}
        >
          <img
            src={avatarUrl({ id: user.id, avatar: user.avatar }, 64)}
            alt="내 디스코드 프로필"
            width={28}
            height={28}
            referrerPolicy="no-referrer"
            style={{ borderRadius: '50%', display: 'block' }}
          />
          <span className="user">{user.username ?? user.name ?? '사용자'}</span>
        </span>
        <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
      </div>

      {storyId ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : tab === 'admin' && isAdmin ? (
        <AdminPanel onOpen={setStoryId} />
      ) : (
        <StoryList onOpen={setStoryId} />
      )}
    </div>
  );
}
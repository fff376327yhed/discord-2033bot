// 앱 화면: 로그인 → 내 스토리 목록 → 편집기 (+ 운영자라면 관리자 탭)
// 예전의 Login.jsx, StoryList.jsx 를 이 파일 안으로 합쳤다.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Editor from './Editor.jsx';

/* ───────────────────────── Login ───────────────────────── */

function Login() {
  return (
    <div className="center-screen">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <h1>🚇 해정2033 창작마당</h1>
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

function AdminPanel() {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // { kind: 'hide' | 'block', report }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  function reload() {
    setError(null);
    setReports(null);
    const request = status === 'hidden'
      ? api.adminHiddenStories().then((data) => data.stories)
      : status === 'blocked'
        ? api.adminBlockedUsers().then((data) => data.users)
        : api.adminReports(status).then((data) => data.reports);
    request
      .then((list) => setReports(list ?? []))
      .catch((err) => setError(err.message));
  }
  useEffect(reload, [status]);

  async function act(fn) {
    setBusy(true);
    try {
      await fn();
      setPending(null);
      setReason('');
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openConfirm(kind, report) {
    setPending({ kind, report });
    setReason('');
  }

  // 숨김/차단이 성공하면 이 신고도 자동으로 '처리 완료'로 넘긴다.
  function confirm() {
    const { kind, report } = pending;
    act(async () => {
      if (kind === 'hide') await api.adminHideStory(report.storyId, true, reason.trim());
      else await api.adminBlockUser(report.authorId, true, reason.trim());
      await api.adminResolveReport(report.id, 'resolved');
    });
  }

  function unhide(story) {
    act(() => api.adminHideStory(story.id, false, ''));
  }

  function unblock(user) {
    act(() => api.adminBlockUser(user.id, false, ''));
  }

  return (
    <div className="story-list">
      <div style={{ display: 'flex', gap: 8 }}>
        {['open', 'resolved', 'dismissed', 'hidden', 'blocked'].map((s) => (
          <button
            key={s}
            className={`btn btn-small ${status === s ? 'btn-primary' : ''}`}
            onClick={() => setStatus(s)}
          >
            {{ open: '대기', resolved: '처리됨', dismissed: '기각', hidden: '숨긴 스토리', blocked: '차단한 사용자' }[s]}
          </button>
        ))}
      </div>

      {error && <div>⚠️ {error}</div>}
      {!error && !reports && <div>불러오는 중...</div>}
      {reports?.length === 0 && <p style={{ color: 'var(--muted)' }}>신고가 없습니다.</p>}

      {status === 'hidden' && reports?.map((story) => (
        <div key={story.id} className="story-row" style={{ cursor: 'default' }}>
          <div style={{ width: '100%' }}>
            <div>{story.title || '(제목 없음)'}</div>
            <div className="meta">
              {story.hiddenReason && <>{story.hiddenReason} · </>}
              {new Date(story.hiddenAt).toLocaleString('ko-KR')} · 작성자 {story.authorId}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-small" disabled={busy} onClick={() => unhide(story)}>숨김 해제</button>
            </div>
          </div>
        </div>
      ))}

      {status === 'blocked' && reports?.map((u) => (
        <div key={u.id} className="story-row" style={{ cursor: 'default' }}>
          <div style={{ width: '100%' }}>
            <div>사용자 {u.id}</div>
            <div className="meta">
              {u.blockedReason && <>{u.blockedReason} · </>}
              {new Date(u.blockedAt).toLocaleString('ko-KR')}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-small" disabled={busy} onClick={() => unblock(u)}>차단 해제</button>
            </div>
          </div>
        </div>
      ))}

      {status !== 'hidden' && status !== 'blocked' && reports?.map((r) => {
        const isPending = pending?.report.id === r.id;
        return (
          <div key={r.id} className="story-row" style={{ cursor: 'default' }}>
            <div style={{ width: '100%' }}>
              <div>
                {r.storyTitle || '(제목 없음)'} <span className="badge">{REASON_LABELS[r.reason] ?? r.reason}</span>
              </div>
              <div className="meta">
                {r.detail && <>{r.detail} · </>}
                {new Date(r.createdAt).toLocaleString('ko-KR')} · 스토리 {r.storyId}
              </div>
              {r.handledAt > 0 && (
                <div className="meta">
                  {r.status === 'dismissed' ? '기각' : '처리'} {new Date(r.handledAt).toLocaleString('ko-KR')}
                  {r.handledBy && <> · 처리자 {r.handledBy}</>}
                </div>
              )}
              {status === 'open' && !isPending && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.adminResolveReport(r.id, 'resolved'))}>처리 완료</button>
                  <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.adminResolveReport(r.id, 'dismissed'))}>기각</button>
                  <button className="btn btn-small" onClick={() => openConfirm('hide', r)}>스토리 숨기기</button>
                  <button className="btn btn-small" onClick={() => openConfirm('block', r)}>작성자 차단</button>
                </div>
              )}
              {isPending && (
                <div style={{ marginTop: 8 }}>
                  <div>
                    {pending.kind === 'hide'
                      ? `「${r.storyTitle || r.storyId}」을(를) 숨깁니다.`
                      : `작성자 ${r.authorId}을(를) 차단합니다.`}
                  </div>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="사유 (선택, 100자 이내)"
                    maxLength={100}
                    style={{ width: '100%', marginTop: 6 }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button className="btn btn-small btn-primary" disabled={busy} onClick={confirm}>확인</button>
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
        <strong>🚇 해정2033 창작마당</strong>
        {isAdmin && !storyId && (
          <>
            <button className={`btn btn-small ${tab === 'stories' ? 'btn-primary' : ''}`} onClick={() => setTab('stories')}>내 스토리</button>
            <button className={`btn btn-small ${tab === 'admin' ? 'btn-primary' : ''}`} onClick={() => setTab('admin')}>관리자</button>
          </>
        )}
        <div className="spacer" />
        <span className="user">{user.username ?? user.name ?? '사용자'}</span>
        <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
      </div>

      {storyId ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : tab === 'admin' && isAdmin ? (
        <AdminPanel />
      ) : (
        <StoryList onOpen={setStoryId} />
      )}
    </div>
  );
}

// 앱 전체 화면: 상단바 + 탭(내 스토리 / 둘러보기) + 다크 모드
// 예전의 BrowseStories.jsx 를 이 파일 안으로 합쳤다.
import { useEffect, useState } from 'react';
import { api } from './lib.js';
import Editor from './Editor.jsx';

/* ───────────────────────── 내 스토리 ───────────────────────── */

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

/* ───────────────────────── 둘러보기 (공개 스토리 검색, 태그, 정렬, 좋아요, 엔딩 도감) ───────────────────────── */

const ENDING_TYPE = { good: '굿', bad: '배드', hidden: '히든' };

const browseStyles = {
  bar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  card: { border: '1px solid var(--border)', borderRadius: 14, padding: 14, marginBottom: 10 },
  chip: (active) => ({
    padding: '2px 10px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer',
    background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'inherit',
  }),
};

function BrowseStories({ user }) {
  const [input, setInput] = useState('');   // 입력창에 쓰는 중인 글자
  const [query, setQuery] = useState('');   // 실제로 검색에 쓰이는 글자 (엔터/버튼 때 확정)
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('latest');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [books, setBooks] = useState({});   // { 스토리ID: 엔딩 도감 | 'loading' }

  // 검색 조건이 바뀔 때마다 목록을 다시 불러온다. (이전 요청이 늦게 도착해도 무시)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ sort, offset: String(offset) });
    if (query) params.set('q', query);
    if (tag) params.set('tag', tag);

    api.browse(params)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query, tag, sort, offset]);

  // 조건을 바꾸면 항상 첫 페이지부터
  const changeFilter = (setter) => (value) => { setter(value); setOffset(0); };
  const submitSearch = (event) => { event.preventDefault(); setQuery(input.trim()); setOffset(0); };

  async function toggleLike(story) {
    if (!user) return setError('좋아요는 로그인 후 누를 수 있습니다.');
    try {
      const result = await api.setLike(story.id, !story.liked);
      setData((prev) => ({
        ...prev,
        stories: prev.stories.map((s) => (s.id === story.id ? { ...s, liked: result.liked, likeCount: result.likeCount } : s)),
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleEndings(story) {
    if (!user) return setError('엔딩 도감은 로그인 후 볼 수 있습니다.');
    if (books[story.id] && books[story.id] !== 'loading') {
      setBooks((prev) => { const next = { ...prev }; delete next[story.id]; return next; }); // 접기
      return;
    }
    setBooks((prev) => ({ ...prev, [story.id]: 'loading' }));
    try {
      const book = await api.endings(story.id);
      setBooks((prev) => ({ ...prev, [story.id]: book }));
    } catch (err) {
      setBooks((prev) => { const next = { ...prev }; delete next[story.id]; return next; });
      setError(err.message);
    }
  }

  return (
    <section>
      <form onSubmit={submitSearch} style={browseStyles.bar}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={50}
          placeholder="제목, 설명, 태그 검색"
          style={{ flex: 1, minWidth: 160 }}
        />
        <button type="submit">검색</button>
        <select value={sort} onChange={(e) => changeFilter(setSort)(e.target.value)}>
          <option value="latest">최신순</option>
          <option value="popular">인기순</option>
        </select>
      </form>

      {data?.tags?.length > 0 && (
        <div style={{ ...browseStyles.bar, gap: 6 }}>
          <button type="button" style={browseStyles.chip(!tag)} onClick={() => changeFilter(setTag)('')}>전체</button>
          {data.tags.map(({ tag: name, count }) => (
            <button key={name} type="button" style={browseStyles.chip(tag === name)} onClick={() => changeFilter(setTag)(tag === name ? '' : name)}>
              #{name} {count}
            </button>
          ))}
        </div>
      )}

      {error && <p role="alert" style={{ color: '#ed4245' }}>⚠️ {error}</p>}
      {loading && <p>불러오는 중…</p>}
      {data && !loading && data.stories.length === 0 && <p>조건에 맞는 공개 스토리가 없습니다.</p>}

      {data?.stories.map((story) => {
        const book = books[story.id];
        return (
          <article key={story.id} style={browseStyles.card}>
            <h3 style={{ margin: '0 0 4px' }}>{story.title}</h3>
            <p style={{ margin: '0 0 6px', opacity: 0.8 }}>{story.description || '설명 없음'}</p>
            <p style={{ margin: '0 0 8px', fontSize: 13, opacity: 0.7 }}>
              제작자 {story.authorName ?? '운영자'} · 플레이 {story.playCount}회 · 장면 {story.sceneCount}개
              {story.tags.length > 0 && ` · ${story.tags.map((t) => `#${t}`).join(' ')}`}
            </p>
            <div style={browseStyles.bar}>
              <button type="button" onClick={() => toggleLike(story)} aria-pressed={story.liked}>
                {story.liked ? '❤️' : '🤍'} {story.likeCount}
              </button>
              <button type="button" onClick={() => toggleEndings(story)}>🏁 엔딩 도감</button>
              <code style={{ opacity: 0.6 }}>/플레이 {story.id}</code>
            </div>
            {book === 'loading' && <p>도감 확인 중…</p>}
            {book && book !== 'loading' && (
              <div>
                <strong>엔딩 {book.seenCount} / {book.total}</strong>
                <ul>
                  {book.seen.map((ending) => (
                    <li key={ending.sceneId}>{ending.name} ({ENDING_TYPE[ending.type] ?? '엔딩'})</li>
                  ))}
                  {book.total > book.seenCount && <li>❓ 아직 못 본 엔딩 {book.total - book.seenCount}개</li>}
                </ul>
              </div>
            )}
          </article>
        );
      })}

      {data && (
        <div style={browseStyles.bar}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>이전</button>
          <span>{data.total === 0 ? 0 : offset + 1}–{offset + data.stories.length} / {data.total}</span>
          <button type="button" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + data.pageSize)}>다음</button>
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 관리자 (신고 처리, 스토리 숨김, 사용자 차단) ───────────────────────── */

const REASON_TEXT = { spam: '스팸/광고', offensive: '불쾌하거나 부적절한 내용', copyright: '저작권 침해', other: '기타' };
const STATUS_TEXT = { open: '처리 전', resolved: '처리 완료', dismissed: '기각' };

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString('ko-KR') : '';
}

function AdminPanel() {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');              // 운영자 메모 (숨김/차단 사유)
  const [manualStory, setManualStory] = useState(''); // 직접 처리: 스토리 ID
  const [manualUser, setManualUser] = useState('');   // 직접 처리: 사용자 ID

  // 신고 목록: 탭(처리 전/완료/기각)이 바뀔 때마다 다시 불러온다. (늦게 도착한 이전 응답은 무시)
  useEffect(() => {
    let cancelled = false;
    setReports(null);
    setError('');
    api.adminReports(status)
      .then((data) => !cancelled && setReports(data.reports))
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [status]);

  // 요청 1건 실행: 중복 클릭 막기 + 오류/완료 안내. 성공하면 true
  async function run(task, doneText) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
      setNotice(doneText);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function closeReport(report, next) {
    const ok = await run(() => api.adminResolveReport(report.id, next), next === 'resolved' ? '처리 완료로 표시했습니다.' : '기각했습니다.');
    if (ok) setReports((prev) => prev.filter((item) => item.id !== report.id));
  }

  const hideStory = (storyId, hidden) =>
    run(() => api.adminHideStory(storyId, hidden, note.trim()), hidden ? '스토리를 숨겼습니다.' : '숨김을 해제했습니다.');

  function blockUser(userId, blocked) {
    if (blocked && !window.confirm('이 사용자를 차단할까요? 로그인이 끊기고 플레이도 막힙니다.')) return;
    return run(() => api.adminBlockUser(userId, blocked, note.trim()), blocked ? '사용자를 차단했습니다.' : '차단을 해제했습니다.');
  }

  return (
    <div className="story-list">
      <div className="tabs" role="tablist" aria-label="신고 상태">
        {Object.entries(STATUS_TEXT).map(([key, text]) => (
          <button key={key} type="button" className={`tab ${status === key ? 'active' : ''}`} aria-current={status === key} onClick={() => setStatus(key)}>
            {text}
          </button>
        ))}
      </div>

      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="admin-note">운영자 메모 (숨김/차단 사유, 100자 이하 · 선택)</label>
        <input id="admin-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="예: 광고성 스토리" />
      </div>

      {error && <p role="alert" className="validation-error" style={{ margin: 0 }}>⚠️ {error}</p>}
      {notice && <p role="status" className="validation-ok" style={{ margin: 0 }}>✅ {notice}</p>}

      {!reports && !error && <p className="muted">불러오는 중...</p>}
      {reports && reports.length === 0 && <p className="muted">{STATUS_TEXT[status]} 신고가 없습니다.</p>}

      {reports?.map((report) => (
        <div key={report.id} className="card" style={{ marginBottom: 0 }}>
          <div className="card-title">
            {report.storyTitle || '(제목 없음)'} <span className="badge">{REASON_TEXT[report.reason] ?? report.reason}</span>
          </div>
          {report.detail && <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{report.detail}</p>}
          <div className="hint" style={{ marginBottom: 10 }}>
            신고 {formatTime(report.createdAt)} · 신고자 {report.userId} · 제작자 {report.authorId}
            <br />
            스토리 ID <code>{report.storyId}</code>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => hideStory(report.storyId, true)}>🙈 숨기기</button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => hideStory(report.storyId, false)}>숨김 해제</button>
            <button type="button" className="btn btn-small btn-danger-outline" disabled={busy} onClick={() => blockUser(report.authorId, true)}>🚫 제작자 차단</button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => blockUser(report.authorId, false)}>차단 해제</button>
          </div>
          {status === 'open' && (
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => closeReport(report, 'resolved')}>✔ 처리 완료</button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => closeReport(report, 'dismissed')}>기각</button>
            </div>
          )}
        </div>
      ))}

      <div className="card soft" style={{ marginBottom: 0 }}>
        <div className="card-title">직접 처리 (ID 입력)</div>
        <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          <input value={manualStory} onChange={(e) => setManualStory(e.target.value.trim())} maxLength={64} placeholder="스토리 ID" />
          <button type="button" className="btn btn-small" disabled={busy || !manualStory} onClick={() => hideStory(manualStory, true)}>숨기기</button>
          <button type="button" className="btn btn-small" disabled={busy || !manualStory} onClick={() => hideStory(manualStory, false)}>숨김 해제</button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input value={manualUser} onChange={(e) => setManualUser(e.target.value.trim())} maxLength={25} inputMode="numeric" placeholder="디스코드 사용자 ID" />
          <button type="button" className="btn btn-small btn-danger-outline" disabled={busy || !manualUser} onClick={() => blockUser(manualUser, true)}>차단</button>
          <button type="button" className="btn btn-small" disabled={busy || !manualUser} onClick={() => blockUser(manualUser, false)}>차단 해제</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 다크 모드 ───────────────────────── */

// 저장된 선택이 없으면 null → 컴퓨터/폰의 설정을 따른다.
function readSavedTheme() {
  try {
    const value = localStorage.getItem('theme');
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null; // 저장소를 못 쓰는 환경이어도 화면은 정상 동작
  }
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/* ───────────────────────── AdminPanel (관리자) ───────────────────────── */

function AdminPanel() {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);

  function reload() {
    setError(null);
    setReports(null);
    api.adminReports(status)
      .then((data) => setReports(data.reports ?? []))
      .catch((err) => setError(err.message));
  }
  useEffect(reload, [status]);

  async function act(fn) {
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  function hideStory(report) {
    const reason = window.prompt('숨김 사유를 입력하세요');
    if (reason === null) return;
    act(() => api.adminHideStory(report.storyId, true, reason));
  }

  function blockUser(report) {
    const reason = window.prompt('차단 사유를 입력하세요');
    if (reason === null) return;
    act(() => api.adminBlockUser(report.authorId, true, reason));
  }

  return (
    <div className="story-list">
      <div style={{ display: 'flex', gap: 8 }}>
        {['open', 'resolved', 'dismissed'].map((s) => (
          <button
            key={s}
            className={`btn btn-small ${status === s ? 'btn-primary' : ''}`}
            onClick={() => setStatus(s)}
          >
            {{ open: '대기', resolved: '처리됨', dismissed: '기각' }[s]}
          </button>
        ))}
      </div>

      {error && <div>⚠️ {error}</div>}
      {!error && !reports && <div>불러오는 중...</div>}
      {reports?.length === 0 && <p style={{ color: 'var(--muted)' }}>신고가 없습니다.</p>}

      {reports?.map((r) => (
        <div key={r.id} className="story-row" style={{ cursor: 'default' }}>
          <div>
            <div>스토리 {r.storyId}</div>
            <div className="meta">{r.reason}</div>
            {status === 'open' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button className="btn btn-small" onClick={() => act(() => api.adminResolveReport(r.id, 'resolved'))}>처리 완료</button>
                <button className="btn btn-small" onClick={() => act(() => api.adminResolveReport(r.id, 'dismissed'))}>기각</button>
                <button className="btn btn-small" onClick={() => hideStory(r)}>스토리 숨기기</button>
                <button className="btn btn-small" onClick={() => blockUser(r)}>작성자 차단</button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── App ───────────────────────── */

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = 확인 중, null = 비로그인
  const [isAdmin, setIsAdmin] = useState(false); // 서버가 알려 준 운영자 여부 (탭을 보일지만 정한다. 진짜 권한은 서버가 확인)
  const [tab, setTab] = useState('mine'); // 'mine' = 내 스토리, 'browse' = 둘러보기, 'admin' = 관리자
  const [storyId, setStoryId] = useState(null);
  const [theme, setTheme] = useState(readSavedTheme); // 'dark' | 'light' | null(시스템 설정 따름)

  // <html data-theme="..."> 로 css의 다크 색상을 켜고 끈다.
  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);

  const isDark = theme ? theme === 'dark' : systemPrefersDark();

  function toggleTheme() {
    const next = isDark ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('theme', next); } catch { /* 저장 실패해도 이번 방문에는 적용됨 */ }
  }

  useEffect(() => {
    api.me()
      .then((data) => {
        setUser(data.user);
        setIsAdmin(Boolean(data.user && data.isAdmin));
      })
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div style={{ padding: 20 }}>불러오는 중...</div>;
  }

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setIsAdmin(false);
      setTab('mine');
      setStoryId(null);
    }
  }

  // 로그인 안 한 사람은 항상 '둘러보기'만 보인다.
  const activeTab = !user ? 'browse' : tab === 'admin' && !isAdmin ? 'mine' : tab;
  const editing = Boolean(user && storyId);

  return (
    <div>
      <div className="topbar">
        <strong className="brand">🚇 해정2033 창작마당</strong>

        {/* 편집 중에는 화면을 넓게 쓰려고 탭을 숨긴다 */}
        {user && !editing && (
          <nav className="tabs" aria-label="메뉴">
            <button type="button" className={`tab ${activeTab === 'mine' ? 'active' : ''}`} aria-current={activeTab === 'mine'} onClick={() => setTab('mine')}>내 스토리</button>
            <button type="button" className={`tab ${activeTab === 'browse' ? 'active' : ''}`} aria-current={activeTab === 'browse'} onClick={() => setTab('browse')}>둘러보기</button>
            {isAdmin && (
              <button type="button" className={`tab ${activeTab === 'admin' ? 'active' : ''}`} aria-current={activeTab === 'admin'} onClick={() => setTab('admin')}>관리자</button>
            )}
          </nav>
        )}

        <div className="spacer" />

        <button
          type="button" className="btn btn-small theme-btn" onClick={toggleTheme}
          aria-label={isDark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기'}
          title={isDark ? '라이트 모드' : '다크 모드'}
        >
          {isDark ? '☀️' : '🌙'}
        </button>

        {user ? (
          <>
            <span className="user">{user.username ?? user.name ?? '사용자'}</span>
            <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
          </>
        ) : (
          <a className="btn btn-small btn-primary" href="/api/auth/login">디스코드로 로그인</a>
        )}
      </div>

      {editing ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : activeTab === 'mine' ? (
        <StoryList onOpen={setStoryId} />
      ) : activeTab === 'admin' ? (
        <AdminPanel />
      ) : (
        <div className="browse-wrap">
          <BrowseStories user={user} />
        </div>
      )}
    </div>
  );
}

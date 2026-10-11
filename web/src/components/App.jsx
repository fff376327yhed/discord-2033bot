import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Login from './Login.jsx';
import StoryList from './StoryList.jsx';
import Editor from './Editor.jsx';

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = 확인 중, null = 비로그인
  const [storyId, setStoryId] = useState(null);

  useEffect(() => {
    api.me()
      .then((data) => setUser(data.user))
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
      setUser(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <strong>🚇 해정2033 창작마당</strong>
        <div className="spacer" />
        <span className="user">{user.username ?? user.name ?? '사용자'}</span>
        <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
      </div>

      {storyId ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : (
        <StoryList onOpen={setStoryId} />
      )}
    </div>
  );
}

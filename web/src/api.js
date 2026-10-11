// 백엔드(api/index.js, 즉 src/bundle.js의 createWebRouter)에 요청을 보내는 도우미.
// 운영에서는 /api가 같은 Vercel 배포에 있어서 같은 출처(same-origin)이고,
// 개발에서는 vite.config.js의 proxy가 /api를 로컬 Express 서버(3000번)로 넘겨준다.
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'haejung'; // src/bundle.js WEB.CSRF_VALUE 와 반드시 같아야 한다

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = CSRF_VALUE;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (HTTP ${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    err.validation = data?.validation;
    err.currentUpdatedAt = data?.currentUpdatedAt;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  myStories: () => request('/stories/mine'),
  createStory: (body) => request('/stories', { method: 'POST', body }),
  getStory: (id) => request(`/stories/${id}`),
  updateStory: (id, body) => request(`/stories/${id}`, { method: 'PUT', body }),
  saveScenes: (id, body) => request(`/stories/${id}/scenes`, { method: 'PUT', body }),
  validateStory: (id) => request(`/stories/${id}/validate`),
  validateDraft: (body) => request('/validate', { method: 'POST', body }),
  setVisibility: (id, isPublic) => request(`/stories/${id}/visibility`, { method: 'PATCH', body: { isPublic } }),
  deleteStory: (id) => request(`/stories/${id}`, { method: 'DELETE' }),
};
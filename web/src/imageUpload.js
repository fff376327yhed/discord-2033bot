// 사진 줄이기 + 올리기 도구 (브라우저에서 실행)
// 순서: 선택한 사진 → 캔버스에 작게 그림 → WebP로 저장(안 되면 JPEG) → 목표 크기보다 크면 화질/크기를 더 낮춤 → 서버로 전송
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'haejung';

// 일반 유저는 작게(서버 한도 800KB보다 훨씬 작게), 관리자는 크고 선명하게 줄인다.
const PRESETS = {
  user: { maxSide: 1280, targetBytes: 350 * 1024, startQuality: 0.82, minQuality: 0.5 },
  admin: { maxSide: 2560, targetBytes: 1500 * 1024, startQuality: 0.9, minQuality: 0.6 },
};

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 사진 파일을 줄여서 Blob 으로 돌려준다. */
export async function compressImage(file, isAdmin = false) {
  if (!file || !file.type.startsWith('image/')) throw new Error('사진 파일만 고를 수 있어요.');
  if (file.type === 'image/svg+xml') throw new Error('SVG는 올릴 수 없어요. PNG나 JPG를 써 주세요.');
  if (file.size > 30 * 1024 * 1024) throw new Error('원본이 너무 커요. (30MB 이하만 가능)');

  const preset = isAdmin ? PRESETS.admin : PRESETS.user;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); // 휴대폰 사진의 회전 정보 반영
  } catch {
    throw new Error('이 사진은 읽을 수 없어요. 다른 사진을 골라 주세요.');
  }

  let scale = Math.min(1, preset.maxSide / Math.max(bitmap.width, bitmap.height));
  let best = null;
  for (let round = 0; round < 4; round += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    for (let q = preset.startQuality; q >= preset.minQuality - 0.001; q -= 0.08) {
      let blob = await canvasToBlob(canvas, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', q); // 오래된 브라우저 대비
      if (!blob) throw new Error('사진을 줄이지 못했어요.');
      best = blob;
      if (blob.size <= preset.targetBytes) {
        bitmap.close?.();
        return blob;
      }
    }
    scale *= 0.8; // 그래도 크면 가로세로를 20% 더 줄여서 다시
  }
  bitmap.close?.();
  return best;
}

async function request(path, { method = 'GET', body, contentType } = {}) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;
  const res = await fetch(`/api${path}`, { method, headers, credentials: 'include', body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 서버가 JSON이 아닌 답을 준 경우 */ }
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (HTTP ${res.status})`);
    err.status = res.status;
    err.usage = data?.usage;
    throw err;
  }
  return data;
}

export const uploadApi = {
  mine: () => request('/uploads/mine'),
  upload: (blob) => request('/uploads', { method: 'POST', body: blob, contentType: blob.type }),
  remove: (id) => request(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  adminStats: () => request('/admin/upload-stats'),
  adminResync: () => request('/admin/upload-stats/resync', { method: 'POST' }),
};

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

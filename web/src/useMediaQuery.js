// 화면 폭 같은 조건(CSS 미디어 쿼리)이 지금 맞는지 알려주는 작은 도구.
// 예: const isMobile = useMediaQuery('(max-width: 900px)');
// 창 크기를 바꾸면 자동으로 다시 계산된다.
import { useEffect, useState } from 'react';

export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

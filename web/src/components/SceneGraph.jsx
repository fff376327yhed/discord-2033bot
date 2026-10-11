import { useRef, useState, useEffect } from 'react';

const NODE_W = 180, NODE_H = 70;

export default function SceneGraph({ scenes, selected, onSelect, startSceneId, onMove, onAddAt }) {
  const canvasRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { key, offsetX, offsetY }

  useEffect(() => {
    if (!dragging) return;
    function handleMove(e) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
      const y = e.clientY - rect.top + canvasRef.current.scrollTop;
      onMove(dragging.key, Math.max(0, Math.round(x - dragging.offsetX)), Math.max(0, Math.round(y - dragging.offsetY)));
    }
    function handleUp() { setDragging(null); }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging, onMove]);

  function onPointerDown(e, key) {
    const scene = scenes[key];
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
    const y = e.clientY - rect.top + canvasRef.current.scrollTop;
    setDragging({ key, offsetX: x - (scene.posX ?? 0), offsetY: y - (scene.posY ?? 0) });
    onSelect(key);
    e.stopPropagation();
  }

  function onCanvasDoubleClick(e) {
    if (!e.target.classList.contains('graph-canvas') && !e.target.classList.contains('graph-inner')) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
    const y = e.clientY - rect.top + canvasRef.current.scrollTop;
    onAddAt(Math.round(x - NODE_W / 2), Math.round(y - NODE_H / 2));
  }

  const entries = Object.entries(scenes);
  const edges = [];
  for (const [key, scene] of entries) {
    for (const choice of scene.choices ?? []) {
      if (choice.to && scenes[choice.to]) edges.push({ from: key, to: choice.to });
    }
  }
  const width = Math.max(1200, ...entries.map(([, s]) => (s.posX ?? 0) + NODE_W + 100), 0);
  const height = Math.max(800, ...entries.map(([, s]) => (s.posY ?? 0) + NODE_H + 100), 0);

  function center(key) {
    const s = scenes[key];
    return { x: (s.posX ?? 0) + NODE_W / 2, y: (s.posY ?? 0) + NODE_H / 2 };
  }

  return (
    <div ref={canvasRef} className="graph-canvas" onDoubleClick={onCanvasDoubleClick} title="빈 곳을 더블클릭하면 그 위치에 장면이 추가됩니다">
      <svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--border)" />
          </marker>
        </defs>
        {edges.map((edge, i) => {
          const a = center(edge.from), b = center(edge.to);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border)" strokeWidth="2" markerEnd="url(#arrow)" />;
        })}
      </svg>
      <div className="graph-inner" style={{ position: 'relative', width, height }}>
        {entries.map(([key, scene]) => (
          <div
            key={key}
            className={`scene-node ${selected === key ? 'selected' : ''} ${scene.isEnding ? 'ending' : ''} ${key === startSceneId ? 'start-marker' : ''}`}
            style={{ left: scene.posX ?? 0, top: scene.posY ?? 0 }}
            onPointerDown={(e) => onPointerDown(e, key)}
          >
            <div className="title">{key === startSceneId ? '🚩 ' : ''}{scene.isEnding ? '🏁 ' : ''}{key}</div>
            <div className="body-preview">{scene.body || '(본문 없음)'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
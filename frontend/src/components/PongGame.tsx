import React, { useState, useEffect, useRef } from 'react';

const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 80;
const BALL_SIZE = 16;

export const PongGame: React.FC<{ active: boolean }> = ({ active }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ball, setBall] = useState({ x: 200, y: 150, dx: 7, dy: 7 });
  const [playerY, setPlayerY] = useState(150);
  const [aiY, setAiY] = useState(150);
  const [score, setScore] = useState({ player: 0, ai: 0 });
  const requestRef = useRef<number | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active) return;
      const speed = 40; // Increased paddle speed
      if (e.key === 'ArrowUp') setPlayerY((y) => Math.max(PADDLE_HEIGHT / 2, y - speed));
      if (e.key === 'ArrowDown') setPlayerY((y) => Math.min((containerRef.current?.offsetHeight || 300) - PADDLE_HEIGHT / 2, y + speed));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const animate = () => {
      if (!containerRef.current) return;
      const { offsetWidth: w, offsetHeight: h } = containerRef.current;
      
      let { x, y, dx, dy } = ball;
      x += dx;
      y += dy;

      if (y <= 0 || y >= h - BALL_SIZE) dy *= -1;

      // Paddle collisions
      if ((x <= 25 && y > playerY - PADDLE_HEIGHT / 2 && y < playerY + PADDLE_HEIGHT / 2) ||
          (x >= w - 25 - BALL_SIZE && y > aiY - PADDLE_HEIGHT / 2 && y < aiY + PADDLE_HEIGHT / 2)) {
        dx *= -1.1;
      }

      // Scoring
      if (x < 0) { setScore(s => ({...s, ai: s.ai + 1})); x = w/2; dx = 7; }
      else if (x > w) { setScore(s => ({...s, player: s.player + 1})); x = w/2; dx = -7; }

      setAiY((prev) => prev + (y - prev) * 0.15); // Faster AI
      setBall({ x, y, dx, dy });
      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current!);
  }, [active, ball, playerY, aiY]);

  return (
    <div ref={containerRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', fontSize: '2rem', fontWeight: 500, color: 'var(--text)', opacity: 0.3 }}>
        {score.player} : {score.ai}
      </div>
      <div style={{ position: 'absolute', left: ball.x, top: ball.y, width: BALL_SIZE, height: BALL_SIZE, background: 'var(--accent)', borderRadius: '50%' }} />
      <div style={{ position: 'absolute', left: 10, top: playerY - PADDLE_HEIGHT / 2, width: PADDLE_WIDTH, height: PADDLE_HEIGHT, background: 'var(--text)' }} />
      <div style={{ position: 'absolute', right: 10, top: aiY - PADDLE_HEIGHT / 2, width: PADDLE_WIDTH, height: PADDLE_HEIGHT, background: 'var(--text)' }} />
    </div>
  );
};

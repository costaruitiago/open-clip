import { Link } from 'react-router-dom';

export function Header() {
  return (
    <Link to="/" className="wordmark-link">
      <svg width="18" height="18" aria-hidden="true">
        <use href="/icons.svg#play-icon" />
      </svg>
      <span className="wordmark">Open Clip</span>
    </Link>
  );
}

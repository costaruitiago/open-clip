import React from 'react';

interface NavButtonProps {
  onClick: () => void;
  children: React.ReactNode;
}

export const NavButton: React.FC<NavButtonProps> = ({ onClick, children }) => (
  <button type="button" className="nav-action" onClick={onClick}>
    {children}
  </button>
);

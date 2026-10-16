import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmationModal } from './ConfirmationModal';

describe('ConfirmationModal Component', () => {
  it('offers a third choice when given one', () => {
    const onAlternative = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmationModal
        isOpen={true}
        title="Regenerate clips?"
        message="Message"
        confirmText="Regenerate & replace"
        alternative={{ text: 'Upload without regenerating', onClick: onAlternative }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
    screen.getByRole('button', { name: 'Upload without regenerating' }).click();
    expect(onAlternative).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not render when isOpen is false', () => {
    const { container } = render(
      <ConfirmationModal 
        isOpen={false} 
        title="Test" 
        message="Message" 
        onConfirm={vi.fn()} 
        onCancel={vi.fn()} 
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders correctly when isOpen is true', () => {
    render(
      <ConfirmationModal 
        isOpen={true} 
        title="Delete Test" 
        message="Are you sure?" 
        onConfirm={vi.fn()} 
        onCancel={vi.fn()} 
      />
    );
    expect(screen.getByText(/Delete Test/i)).toBeDefined();
    expect(screen.getByText(/Are you sure?/i)).toBeDefined();
  });
});

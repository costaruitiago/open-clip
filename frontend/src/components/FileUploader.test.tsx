import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FileUploader } from './FileUploader';

describe('FileUploader Component', () => {
  it('renders the upload instructions correctly when no file is selected', () => {
    render(
      <FileUploader 
        onFileSelect={vi.fn()} 
        isPending={false} 
        uploadProgress={0}
        onSubmit={vi.fn()} 
      />
    );
    
    expect(screen.getByText(/Drop a recording to cut it into clips/i)).toBeDefined();
    expect(screen.getByText(/finds the highlights/i)).toBeDefined();
  });

  it('renders the "Choose a video" action', () => {
    render(
      <FileUploader 
        onFileSelect={vi.fn()} 
        isPending={false} 
        uploadProgress={0}
        onSubmit={vi.fn()} 
      />
    );
    
    expect(screen.getByText(/Choose a video/i)).toBeDefined();
  });
});

import React, { useState, useEffect, useRef } from 'react';
import { PongGame } from './PongGame';

import { getSpinnerVerb } from '../utils/spinnerVerbs';

// ... (remove UPLOAD_VERBS and PROCESSING_VERBS arrays)

interface FileUploaderProps {
  onFileSelect: (file: File) => void;
  isPending: boolean;
  uploadProgress: number;
  /**
   * Creates the project from the chosen file alone. Resolution and aspect
   * ratio are not asked for here: the project starts on the application
   * defaults, and both are changed in Project settings against the clip
   * previews, which is where you can actually see what the choice does.
   */
  onSubmit: () => void;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ onFileSelect, isPending, uploadProgress, onSubmit }) => {
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [spinnerVerb, setSpinnerVerb] = useState(getSpinnerVerb());
  const [showGame, setShowGame] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setSpinnerVerb(getSpinnerVerb());
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isPending) setShowGame(false);
    // Deliberately avoids Space/Enter: those activate whatever control the user
    // currently has focused, so binding them here would swallow every button
    // press on the page for the duration of the upload.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPending) return;
      if (e.key === 'p' || e.key === 'P') setShowGame(true);
      if (e.key === 'Escape') setShowGame(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPending]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      onFileSelect(selectedFile);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      setFile(droppedFile);
      onFileSelect(droppedFile);
    }
  };

  // Only the empty dropzone is itself a control. Once a file is chosen the
  // panel contains its own buttons and selects, so it must not also be one.
  const isInteractive = !isPending && !file;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center', 
        // Fills the page under the header, so the first screen is one
        // composed surface rather than a strip with a dead band below it.
        minHeight: 'min(560px, calc(100vh - 160px))',
        padding: 'var(--space-xl)', 
        border: dragActive ? '1px dashed var(--accent)' : '1px dashed var(--hairline-strong)', 
        borderRadius: 'var(--radius-xl)',
        textAlign: 'center',
        backgroundColor: dragActive ? 'color-mix(in srgb, var(--accent) 5%, var(--bg-raised))' : 'var(--bg-raised)',
        cursor: isPending ? 'default' : 'pointer',
        transition: 'border-color 150ms var(--ease-out-quart), background-color 150ms var(--ease-out-quart)',
        position: 'relative'
      }}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onClick={() => isInteractive && fileInputRef.current?.click()}
      {...(isInteractive ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': 'Choose a video file to upload, or drop one here',
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        },
      } : {})}
    >
      <input 
        ref={fileInputRef} 
        type="file" 
        accept="video/*" 
        style={{ display: 'none' }} 
        onChange={handleFileChange} 
      />
      
      {isPending ? (
        <div 
          style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center',
            gap: 'var(--space-md)',
            padding: 'var(--space-xl)',
            width: '100%',
            height: '100%',
            zIndex: 1
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div className="spinner" style={{ 
                width: '32px', 
                height: '32px', 
                border: '2px solid var(--hairline-strong)',
                borderTop: '2px solid var(--accent)',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite' 
            }} />
            <h1 style={{ fontSize: '1.25rem', margin: 'var(--space-lg) 0 var(--space-xs)', color: 'var(--text)' }}>
                {spinnerVerb}
            </h1>
            <p className="mono" style={{ fontSize: '0.8125rem', margin: '0 0 var(--space-md)', color: 'var(--text-secondary)' }}>
                {uploadProgress < 99 ? `${uploadProgress}%` : 'Almost done'}
            </p>
            {uploadProgress < 99 && (
                <div
                  role="progressbar"
                  aria-valuenow={uploadProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Upload progress"
                  style={{ width: '300px', maxWidth: '100%', height: '4px', background: 'var(--bg-secondary)', borderRadius: '2px', overflow: 'hidden' }}
                >
                <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width 200ms ease-out' }} />
                </div>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', margin: 'var(--space-md) 0 0' }}>
                {uploadProgress < 99 ? 'Keep this window open until the upload finishes' : 'Setting up the project…'}
            </p>
            {!showGame && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 'var(--space-sm) 0 0' }}>
                Press <kbd className="keycap">P</kbd> for Pong while you wait
                </p>
            )}
          </div>
          {showGame && <PongGame active={isPending} />}
        </div>
      ) : !file ? (
        <>
          <div aria-hidden="true" style={{
            width: '48px',
            height: '48px',
            marginBottom: 'var(--space-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-secondary)',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V3M7 8l5-5 5 5" />
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            </svg>
          </div>
          <h1 style={{ margin: '0 0 var(--space-sm) 0' }}>
            Drop a recording to cut it into clips
          </h1>
          <p style={{ fontSize: '0.9375rem', maxWidth: '30rem', margin: '0 0 var(--space-xl)', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            Open Clip transcribes it, finds the highlights and cuts each one into a short clip
          </p>
          <span className="btn-primary btn-md" style={{ borderRadius: 'var(--radius)', fontWeight: 500 }}>
            Choose a video
          </span>
        </>
      ) : (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          gap: 'var(--space-lg)',
          animation: 'entrance 300ms var(--ease-out-quart) both'
        }}>
          <div style={{ 
            padding: 'var(--space-md) var(--space-lg)', 
            border: 'var(--border)', borderRadius: 'var(--radius-lg)', 
            background: 'var(--bg)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-xs)',
            maxWidth: '100%',
          }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Selected file</span>
            <h3 className="mono" style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 500, overflowWrap: 'anywhere' }}>{file.name}</h3>
          </div>
          <p style={{ margin: 0, maxWidth: '420px', fontSize: '0.8125rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            Resolution and aspect ratio are set in <strong>Project settings</strong>, where
            the clip previews show what you are choosing. You can change them at any time.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <button
              disabled={isPending}
              onClick={(e) => { e.stopPropagation(); onSubmit(); }}
              className="btn-primary btn-lg"
            >
              Create project
            </button>
            <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', justifyContent: 'center' }}>
              {/* Dropping a second file already replaced the selection, but
                  clicking did nothing once one was chosen. This makes the
                  pointer path match the drag path. */}
              <button
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="btn-ghost btn-md"
              >
                Choose another file
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setFile(null); }}
                className="btn-ghost btn-md"
              >
                Remove file
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

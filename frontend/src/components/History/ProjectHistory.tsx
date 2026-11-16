import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectMetadata } from '../../api';
import { deleteProject } from '../../api';
import { ConfirmationModal } from '../ConfirmationModal';
import { Button } from '../Button';

interface ProjectHistoryProps {
  projects: ProjectMetadata[];
}

export const ProjectHistory: React.FC<ProjectHistoryProps> = ({ projects }) => {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<{ isOpen: boolean; projectId: string; projectName: string }>({
    isOpen: false,
    projectId: '',
    projectName: '',
  });

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setConfirmDelete({ isOpen: false, projectId: '', projectName: '' });
    },
  });

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
  };

  return (
    <div className="project-history" style={{ margin: '0 auto', width: '100%' }}>
      <header style={{ margin: 'var(--space-lg) 0 var(--space-xl)', display: 'flex', alignItems: 'baseline', gap: 'var(--space-md)' }}>
        <h1>Projects</h1>
        {projects.length > 0 && (
          <span className="mono" style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{projects.length}</span>
        )}
      </header>

      <div className="card-grid">
        {projects.length > 0 ? (
          projects.map((project, index) => (
            <div
              key={project.project_id}
              className="project-card"
              style={{
                // Six at most get a stagger; the rest arrive with the sixth.
                animationDelay: `${Math.min(index, 5) * 50}ms`,
              }}
            >
              <div>
                <Link
                  to={`/project/${project.project_id}`}
                  style={{
                    fontSize: '1rem',
                    fontWeight: 500,
                    lineHeight: 1.3,
                    display: 'block',
                    marginBottom: 'var(--space-xs)',
                    color: 'inherit',
                    textDecoration: 'none'
                  }}
                >
                  {project.name}
                  {/* Stretches the link over the whole card so the card stays
                      clickable without nesting the Delete button inside it. */}
                  <span style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
                </Link>
                {(() => {
                  const clips = project.highlights?.filter((h: any) => h.is_clip_generated).length ?? 0;
                  return (
                    <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {formatDate(project.created_at)} · {clips} {clips === 1 ? 'clip' : 'clips'}
                    </div>
                  );
                })()}
              </div>
              <div style={{ 
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '0.8125rem',
                marginTop: 'var(--space-lg)',
              }}>
                <span className="project-card__open">
                  Open project
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
                <Button 
                  variant="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete({ 
                      isOpen: true, 
                      projectId: project.project_id, 
                      projectName: project.name 
                    });
                  }}
                  size="sm"
                  style={{
                    position: 'relative',
                    zIndex: 2,
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))
        ) : (
          <div style={{
            gridColumn: '1 / -1',
            padding: 'var(--space-xl)',
            textAlign: 'center',
            border: '1px dashed var(--hairline-strong)',
            borderRadius: 'var(--radius-lg)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-md)'
          }}>
            <h2 style={{ margin: 0 }}>
              No projects yet
            </h2>
            {/* The only place a project can be created is the home route, and
                nothing here previously pointed at it. */}
            <p style={{ margin: 0, maxWidth: '420px', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              Upload a video and Open Clip will transcribe it, find the highlights, and cut them into clips.
            </p>
            <Link
              to="/"
              className="btn-primary btn-md"
              style={{ textDecoration: 'none', display: 'inline-block', borderRadius: 'var(--radius)' }}
            >
              Upload a video
            </Link>
          </div>
        )}
      </div>

      <ConfirmationModal 
        isOpen={confirmDelete.isOpen}
        title="Delete Project"
        message={`Are you sure you want to delete project "${confirmDelete.projectName}"? This action cannot be undone.`}
        onConfirm={() => deleteMutation.mutate(confirmDelete.projectId)}
        onCancel={() => setConfirmDelete({ isOpen: false, projectId: '', projectName: '' })}
      />
    </div>
  );
};

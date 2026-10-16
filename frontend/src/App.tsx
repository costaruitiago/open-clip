import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createProject, getProjects, getProjectMetadata, executePipelineStep, getPipelineConfig, getActiveProcesses, deleteProject, deleteClip, type ProjectMetadata } from './api';
import { ProjectDetail } from './components/ProjectDetail/ProjectDetail';
import { FileUploader } from './components/FileUploader';
import { Header } from './components/Header';
import { Navigation } from './components/Navigation';
import { Breadcrumbs } from './components/Breadcrumbs';
import { ConfirmationModal } from './components/ConfirmationModal';
import { ProjectActions } from './components/ProjectDetail/ProjectActions';
import { ThemeToggle } from './components/ThemeToggle';
import './index.css';

// Split out of the main bundle: none of these are on the path from opening the
// app to working on a project, and settings in particular is the largest view
// in the codebase for something most sessions never visit.
const ClipDetail = lazy(() =>
  import('./components/ClipManagement/ClipDetail').then((m) => ({ default: m.ClipDetail }))
);
const ProjectHistory = lazy(() =>
  import('./components/History/ProjectHistory').then((m) => ({ default: m.ProjectHistory }))
);
const SettingsPage = lazy(() =>
  import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage }))
);

// Cookie Helpers
const getCookie = (name: string): string | null => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift() || null;
  return null;
};

const setCookie = (name: string, value: string, days: number = 365) => {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  document.cookie = `${name}=${value};expires=${date.toUTCString()};path=/;SameSite=Lax`;
};

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const savedTheme = getCookie('app-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') return savedTheme;
    // No stored preference: follow the OS rather than always starting light.
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  
  const [file, setFile] = useState<File | null>(null);
  const queryClient = useQueryClient();
  const [confirmDeleteProject, setConfirmDeleteProject] = useState({
    isOpen: false,
    projectId: '',
    projectName: '',
  });
  // Upload asks first: regenerate every clip and replace its YouTube video, or
  // publish only what is not up yet.
  const [confirmUpload, setConfirmUpload] = useState(false);

  useEffect(() => {
    setCookie('app-theme', theme);
    // Set on <html> so `body` (and the overscroll area behind it) picks the
    // theme up. On an inner div the body kept its light-theme background.
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Helper to extract project ID and clip index from URL
  const projectIdMatch = location.pathname.match(/^\/project\/([a-zA-Z0-9-]+)/);
  const projectId = projectIdMatch ? projectIdMatch[1] : null;
  const clipMatch = location.pathname.match(/\/clip\/(\d+)/);
  const clipIndex = clipMatch ? clipMatch[1] : null;

  const { data: projects = [], refetch: refetchProjects } = useQuery({ 
    queryKey: ['projects'], 
    queryFn: getProjects
  });

  const { data: activeProcesses = [], refetch: refetchProcesses } = useQuery({
    queryKey: ['activeProcesses'],
    queryFn: getActiveProcesses,
    refetchInterval: (query) => (query.state.data && query.state.data.length > 0 ? 1000 : false),
    refetchOnWindowFocus: false,
  });

  // Polling everywhere is gated on `activeProcesses` being non-empty, so the
  // tick that empties it is the last one anybody gets. Refresh the project
  // views once more on that edge, otherwise the UI stays on the second-to-last
  // state (steps stuck on "running", freshly cut clips missing).
  const previousActiveCount = useRef(0);
  useEffect(() => {
    if (previousActiveCount.current > 0 && activeProcesses.length === 0) {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
        queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
        queryClient.invalidateQueries({ queryKey: ['executionStatus', projectId] });
      }
    }
    previousActiveCount.current = activeProcesses.length;
  }, [activeProcesses, projectId, queryClient]);

  const { data: pipelineConfig } = useQuery({
    queryKey: ['pipelineConfig'],
    queryFn: getPipelineConfig,
  });

  const {
    data: projectMetadata,
    error: projectError,
    isLoading: isProjectLoading,
    refetch: refetchProject,
  } = useQuery<ProjectMetadata>({
    queryKey: ['project', projectId],
    queryFn: () => getProjectMetadata(projectId!) as Promise<ProjectMetadata>,
    enabled: !!projectId,
    refetchInterval: () => {
      const isActive = activeProcesses.some(processId => processId.startsWith(`${projectId}_`));
      return isActive ? 1000 : false;
    },
    refetchOnWindowFocus: false,
  });

  const [uploadProgress, setUploadProgress] = useState(0);

  const createMutation = useMutation({
    mutationFn: (vars: { file: File }) =>
      createProject(vars.file, setUploadProgress),
    onSuccess: (data) => {
      // Invalidate project list to reflect new creation immediately
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      // Pre-invalidate potential new project metadata to ensure clean fetch
      queryClient.invalidateQueries({ queryKey: ['project', data.project_id] });
      // The file upload is now handled inside api.ts, so this is clean.
      navigate(`/project/${data.project_id}`);
    },
    onError: (error: any) => {
      console.error(error);
      setUploadProgress(0);
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setConfirmDeleteProject({ isOpen: false, projectId: '', projectName: '' });
      navigate('/history');
    },
    onError: (error: any) => {
      console.error(error);
      setConfirmDeleteProject({ isOpen: false, projectId: '', projectName: '' });
    }
  });

  const deleteClipMutation = useMutation({
    mutationFn: ({ projectId, clipIndex }: { projectId: string, clipIndex: number }) => deleteClip(projectId, clipIndex),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
      // Every per-clip query is keyed by position, and a deletion shifts each
      // later clip down one. Without this, clip N+1 keeps drawing the cached
      // title, cues and thumbnail that were fetched for the clip that used to
      // sit at N. The whole family goes, not just the deleted index, because
      // every index at or after it now names a different clip.
      for (const key of ['clipCaptions', 'clipThumbnail', 'clipDescription', 'clipPublication']) {
        queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
    },
    onError: (error: any) => console.error(error)
  });


  const stepMutation = useMutation({
    mutationFn: ({ action, step, regenerate = false }: { action: 'START' | 'STOP', step: string, regenerate?: boolean }) =>
      executePipelineStep(projectId!, step, action, regenerate),
    onSuccess: () => {
      // Aggressively invalidate to ensure UI sync. ProjectDetail keys its own
      // metadata/status queries separately, so they need invalidating too.
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
      queryClient.invalidateQueries({ queryKey: ['executionStatus', projectId] });
      queryClient.invalidateQueries({ queryKey: ['activeProcesses'] });
      refetchProcesses();
    }
  });

  const handleSubmit = () => {
    if (file) {
      createMutation.mutate({ file });
    }
  };

  // Stable identities: these reach the memoised clip cards, and an inline arrow
  // rebuilt here on every poll tick would make the memo a no-op. `mutate` is
  // itself stable across renders, so the project id is the only real dependency.
  const handleExecuteAction = useCallback(
    (action: 'START' | 'STOP', step: string) => {
      if (action === 'START' && step === 'upload') {
        setConfirmUpload(true);
        return;
      }
      stepMutation.mutate({ action, step });
    },
    [stepMutation]
  );

  const startUpload = (regenerate: boolean) => {
    setConfirmUpload(false);
    stepMutation.mutate({ action: 'START', step: 'upload', regenerate });
  };

  // Said in the dialog rather than discovered afterwards: these are the clips
  // that uploading without regenerating will leave as they are.
  const clipTotal = projectMetadata?.highlights?.length ?? 0;
  const alreadyLive = projectMetadata?.highlights?.filter((h) => h.youtube_video_id).length ?? 0;
  const uploadMessage =
    'Regenerate re-cuts every clip with the current settings and uploads it, then deletes the ' +
    'clip’s old YouTube video — its views and comments go with it. ' +
    (alreadyLive > 0
      ? `Uploading without regenerating skips the ${alreadyLive} of ${clipTotal} clip${clipTotal === 1 ? '' : 's'} already on YouTube; only the rest go up.`
      : 'No clip is on YouTube yet, so either choice uploads all of them.');

  const handleDeleteClip = useCallback(
    (index: number) => deleteClipMutation.mutate({ projectId: projectId!, clipIndex: index }),
    [deleteClipMutation, projectId]
  );

  const handleDeleteProject = useCallback(() => {
    if (!projectMetadata) return;
    setConfirmDeleteProject({
      isOpen: true,
      projectId: projectId!,
      projectName: projectMetadata.name,
    });
  }, [projectId, projectMetadata]);

  const isHome = location.pathname === '/';

  // Every action on the project page used to fail into console.error: the modal
  // closed, the step never started, and the page looked unchanged.
  const errorDetail = (error: unknown) =>
    error instanceof Error ? error.message : 'Please try again.';

  const projectActionFailures = [
    deleteClipMutation.isError && {
      what: 'Could not delete that clip.',
      detail: errorDetail(deleteClipMutation.error),
      dismiss: () => deleteClipMutation.reset(),
    },
    deleteProjectMutation.isError && {
      what: 'Could not delete the project.',
      detail: errorDetail(deleteProjectMutation.error),
      dismiss: () => deleteProjectMutation.reset(),
    },
    stepMutation.isError && {
      what: 'Could not start that pipeline step.',
      detail: errorDetail(stepMutation.error),
      dismiss: () => stepMutation.reset(),
    },
  ].filter(Boolean) as { what: string; detail: string; dismiss: () => void }[];

  // Generate Breadcrumbs
  const breadcrumbs: { label: string; onClick?: () => void }[] = [];
  breadcrumbs.push({ label: 'HOME', onClick: () => navigate('/') });

  if (location.pathname !== '/') {
    breadcrumbs.push({ label: 'PROJECTS', onClick: () => navigate('/history') });
  }

  if (projectId) {
    breadcrumbs.push({ 
      label: projectMetadata?.name || 'Loading...', 
      onClick: () => navigate(`/project/${projectId}`) 
    });
  }

  if (clipIndex) {
    breadcrumbs.push({ label: `CLIP ${parseInt(clipIndex) + 1}` });
  }

  return (
    <div
      style={{
        padding: 'var(--space-md)',
        display: 'flex', 
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)'
      }}
    >
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%'
      }}>
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column',
          width: '100%',
          marginBottom: 'var(--space-sm)',
        }}>
          <div className="app-header">
            <Header />
            {/* Project actions sit with the navigation, not on the page: the
                pipeline, the export and delete all act on the whole project
                rather than on anything in view. Rendered only on a project
                route, and only once its metadata is in — a Delete button that
                outlived the thing it deletes is worse than no button. */}
            <div className="app-header__actions">
              {projectId && projectMetadata && pipelineConfig && (
                <ProjectActions
                  metadata={projectMetadata}
                  pipelineConfig={pipelineConfig}
                  activeProcesses={activeProcesses}
                  onExecuteAction={handleExecuteAction}
                  onDeleteProject={handleDeleteProject}
                />
              )}
              <Navigation
                onHistoryClick={() => { refetchProjects(); navigate('/history'); }}
              />
            </div>
          </div>
          <Breadcrumbs items={breadcrumbs} />
        </div>

        <main
          id="main-content"
          // -1 so the skip link can move focus here without putting the
          // container itself into the tab order.
          tabIndex={-1}
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: isHome ? 'center' : 'flex-start',
            textAlign: isHome ? 'center' : 'left'
          }}
        >
          {/* The fallback is a status line rather than a spinner: these chunks
              are small and usually already cached, so anything heavier would
              flash. */}
          <Suspense fallback={<p role="status">Loading…</p>}>
          <Routes>
            <Route path="/" element={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', width: '100%' }}>
                {createMutation.isError && (
                  <div
                    role="alert"
                    style={{
                      border: '4px solid var(--error)',
                      padding: 'var(--space-md)',
                      backgroundColor: 'var(--bg)',
                      color: 'var(--error)',
                      boxShadow: '4px 4px 0px var(--error)',
                      textAlign: 'left',
                      animation: 'entrance 400ms var(--ease-out-quart)'
                    }}
                  >
                    <strong style={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', marginBottom: '4px' }}>
                      Could not create project
                    </strong>
                    {/* Not uppercased: this is a server message and may be a
                        full sentence or an identifier. */}
                    <span style={{ fontWeight: 500 }}>
                      {createMutation.error instanceof Error ? createMutation.error.message : 'Please try again.'}
                    </span>
                  </div>
                )}
                <FileUploader 
                  onFileSelect={(f) => setFile(f)} 
                  isPending={createMutation.isPending} 
                  uploadProgress={uploadProgress}
                  onSubmit={handleSubmit} 
                />
              </div>
            } />
            <Route path="/project/:id" element={
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                {/* Deleting a clip is the one action on this page whose failure
                    is otherwise invisible: the modal closes either way. */}
                {projectActionFailures.map((failure) => (
                  <div
                    key={failure.what}
                    role="alert"
                    style={{
                      border: '4px solid var(--error)',
                      padding: 'var(--space-sm) var(--space-md)',
                      color: 'var(--error)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 'var(--space-sm)',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                      {failure.what} {failure.detail}
                    </span>
                    <button
                      onClick={failure.dismiss}
                      style={{ border: '4px solid var(--error)', color: 'var(--error)', padding: '0.5rem 1rem', minHeight: '44px' }}
                    >
                      Dismiss
                    </button>
                  </div>
                ))}
                {projectMetadata ? (
                  <ProjectDetail
                    // Keyed, so the page cannot carry one project's state into
                    // another. React reuses a route element across a change of
                    // `:id`, and this component holds per-project state —
                    // which highlight is open, and whether the source video
                    // failed to play. Every path between two projects goes via
                    // /history today, which unmounts it; the first direct link
                    // would have had project B reporting project A's dead
                    // video.
                    key={projectMetadata.project_id}
                    metadata={projectMetadata}
                    pipelineConfig={pipelineConfig || { execution_order: [] }}
                    activeProcesses={activeProcesses}
                    onExecuteAction={handleExecuteAction}
                    onDeleteClip={handleDeleteClip}
                  />
                ) : projectError ? (
                  <div role="alert" style={{ border: '4px solid var(--error)', padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', alignItems: 'flex-start' }}>
                    <strong style={{ fontWeight: 900, textTransform: 'uppercase' }}>Could not load this project</strong>
                    <span style={{ overflowWrap: 'anywhere' }}>
                      {projectError instanceof Error ? projectError.message : 'Please try again.'}
                    </span>
                    <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
                      <button onClick={() => refetchProject()} style={{ padding: '0.5rem 1rem', minHeight: '44px' }}>Try again</button>
                      <button onClick={() => navigate('/history')} style={{ padding: '0.5rem 1rem', minHeight: '44px' }}>Back to projects</button>
                    </div>
                  </div>
                ) : (
                  <p role="status">
                    {isProjectLoading
                      ? 'Loading project…'
                      : 'This project has no data yet. Upload a video to get started.'}
                  </p>
                )}
              </div>
            } />
            <Route path="/project/:id/clip/:clipIndex" element={<ClipDetail />} />
            <Route path="/history" element={
              <ProjectHistory projects={projects} />
            } />
            <Route path="/settings" element={
              <SettingsPage theme={theme} setTheme={setTheme} />
            } />
          </Routes>
          </Suspense>
        </main>
      </div>

      <ConfirmationModal 
        isOpen={confirmDeleteProject.isOpen}
        title="Delete Project"
        message={`Are you sure you want to delete project "${confirmDeleteProject.projectName}"? This action cannot be undone.`}
        // The dialog stays open until the request resolves, so without this a
        // second press fires a second DELETE.
        onConfirm={() => {
          if (deleteProjectMutation.isPending) return;
          deleteProjectMutation.mutate(confirmDeleteProject.projectId);
        }}
        onCancel={() => setConfirmDeleteProject({ isOpen: false, projectId: '', projectName: '' })}
      />
      <ConfirmationModal
        isOpen={confirmUpload}
        title="Regenerate clips?"
        message={uploadMessage}
        confirmText="Regenerate & replace"
        alternative={{ text: 'Upload without regenerating', onClick: () => startUpload(false) }}
        onConfirm={() => startUpload(true)}
        onCancel={() => setConfirmUpload(false)}
      />
      <ThemeToggle theme={theme} setTheme={setTheme} />
    </div>
  );
}

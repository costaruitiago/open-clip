import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './Button';
import { getSettings, updateSettings, type SettingsResponse } from '../api';

type AppSettings = SettingsResponse['settings'];

interface PromoteToDefaultsProps {
  /**
   * The application keys this section maps onto, given what the application
   * already holds.
   *
   * A key is stored whole rather than merged, so a section that promotes half
   * of one — the description text without the template — has to build the other
   * half back out of `current` or blank it. Returning `{}` means the project has
   * nothing of its own here, and the control says so instead of writing nothing.
   */
  build: (current: AppSettings) => Record<string, unknown>;
  /** What promoting these actually changes, in one sentence. */
  hint: string;
  /** Why there is nothing to promote, when `build` comes back empty. */
  emptyHint?: string;
  /**
   * Whether `build` reads `current` at all.
   *
   * A section that fills every key it writes does not, and saying so is what
   * lets this sit outside a dialog: the settings request carries the API keys,
   * and a control that is always on screen would ask for them on every project
   * page rather than when somebody opens the section.
   */
  needsCurrent?: boolean;
  /**
   * Whether to draw the rule that separates this from the section above it.
   *
   * On at the foot of a dialog, where the section is everything above and the
   * rule is what says the button is about all of it. Off in the settings menu,
   * where the bar already groups its own rows and a second rule inside one
   * would read as a third group.
   */
  divider?: boolean;
}

/**
 * Takes what a project decided and makes it what the application decides.
 *
 * A project's settings are where the thinking happens: the user styles captions
 * against real clips, on a real project, and only then knows what they want
 * every project to look like. Without this they would have to remember each
 * value and retype it in Settings — so in practice the application defaults
 * stayed at whatever they shipped as, and every new project started by
 * re-doing the same work.
 *
 * Deliberately one-way. Pulling the application's answer back down over a
 * project would overwrite settings that already describe clips somebody has
 * reviewed; the sections that can follow the application already say so in
 * their own words ("Whatever Settings says"), and that is the way down.
 */
export const PromoteToDefaults: React.FC<PromoteToDefaultsProps> = ({
  build,
  hint,
  emptyHint,
  needsCurrent = true,
  divider = true,
}) => {
  const queryClient = useQueryClient();

  // Shares its cache entry with the Settings page. Inside a dialog it is asked
  // for when the dialog opens, which is the only time this is on screen.
  const { data } = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: getSettings as () => Promise<SettingsResponse>,
    enabled: needsCurrent,
  });

  const mutation = useMutation({
    mutationFn: (settings: Record<string, unknown>) => updateSettings({ settings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      // Two status endpoints answer out of these same keys, and they are what
      // the panels read to name the default they are following.
      queryClient.invalidateQueries({ queryKey: ['youtubeStatus'] });
      queryClient.invalidateQueries({ queryKey: ['postizStatus'] });
    },
  });

  // Null until the application's own settings arrive: a payload built against
  // an empty object would blank every key it only half fills.
  const payload = data ? build(data.settings ?? {}) : needsCurrent ? null : build({});
  const nothingToPromote = payload !== null && Object.keys(payload).length === 0;

  return (
    <div
      style={{
        marginTop: divider ? 'var(--space-lg)' : 0,
        paddingTop: divider ? 'var(--space-md)' : 0,
        borderTop: divider ? 'var(--border)' : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-sm)',
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={payload === null || nothingToPromote || mutation.isPending}
        onClick={() => payload && mutation.mutate(payload)}
        style={{ alignSelf: 'flex-start' }}
      >
        {mutation.isPending ? 'Saving…' : 'Save as application default'}
      </Button>

      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
        {nothingToPromote ? emptyHint ?? 'Nothing here differs from the application settings.' : hint}
      </span>

      {/* Live rather than announced on mount: the button stays where it is and
          only the line under it changes, which a screen reader would otherwise
          never reach. */}
      <span role="status" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {mutation.isSuccess && !mutation.isPending && 'Saved to the application settings.'}
      </span>

      {mutation.isError && (
        <span role="alert" style={{ fontSize: '0.75rem', color: 'var(--error)', lineHeight: 1.4 }}>
          Could not save these as the application default. The application settings are unchanged;
          this project keeps what it has either way.
        </span>
      )}
    </div>
  );
};

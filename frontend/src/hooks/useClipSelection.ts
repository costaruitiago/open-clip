import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSettings, type ProjectMetadata, type SettingsResponse } from '../api';
import { effectiveJevCutoff, selectedIndices } from '../utils/jevSelection';

/**
 * Which of a project's highlights are its clips, for a project whose
 * highlights carry scores. The header's score menu and the clip grid both read
 * this, so they always agree on the split.
 */
export const useClipSelection = (metadata: ProjectMetadata) => {
  const highlights = metadata.highlights ?? [];
  const hasScores = highlights.some((h) => typeof h.jev_scores?.score === 'number');
  const { data: appSettings } = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: getSettings as () => Promise<SettingsResponse>,
    enabled: hasScores,
  });
  const own = metadata.settings?.highlights;
  const cutoff = effectiveJevCutoff(own?.jev_min_score, appSettings?.settings?.jev_min_score);
  const selected = useMemo(
    () => (hasScores ? selectedIndices(highlights, cutoff) : null),
    [hasScores, highlights, cutoff]
  );

  return {
    hasScores,
    cutoff,
    hasOwnCutoff: typeof own?.jev_min_score === 'number',
    /** Null when nothing is scored: every highlight is then a clip. */
    selected,
    total: highlights.length,
  };
};

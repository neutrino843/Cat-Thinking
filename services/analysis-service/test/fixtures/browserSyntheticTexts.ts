// Public synthetic inputs. The isolated harness admits only these hashes.
export const ANALYSIS_SYNTHETIC = {
  normal: 'Synthetic browser fixture. Photosynthesis converts light into stored chemical energy.',
  slow: 'Synthetic browser fixture slow. Photosynthesis converts light into stored chemical energy.',
  partial: 'Synthetic browser fixture partial. Photosynthesis converts light into stored chemical energy.',
  unknown: 'Synthetic browser fixture unknown. Photosynthesis converts light into stored chemical energy.',
  // Keep multipart size while giving each chunk a uniquely locatable quote.
  upload: 'Synthetic browser fixture upload. ' + Array.from({ length: 4_000 }, (_, index) =>
    `Public sample ${index + 1}: Photosynthesis converts light into stored chemical energy.`).join('\n'),
  invalidEvidence: 'Synthetic browser fixture invalid evidence. Photosynthesis converts light into stored chemical energy.',
  truncatedOutline: 'Synthetic browser fixture truncated outline. Photosynthesis converts light into stored chemical energy.',
  hierarchy: 'Synthetic browser fixture hierarchy. Photosynthesis stores light energy in chemical form. Light reactions produce ATP and NADPH. The Calvin cycle uses ATP and NADPH to build sugars from carbon dioxide.',
} as const

import type { Category } from './settings.js';

/**
 * Suggested categories for well-known macOS apps. Suggestions are only ever
 * offered: nothing is tracked until the user accepts a mapping. Browsers and
 * other general-purpose apps are deliberately absent because their use is
 * ambiguous, and guessing would be the kind of inference users can't see.
 */
const EXACT: Readonly<Record<string, Category>> = {
  'com.apple.dt.Xcode': 'coding',
  'com.microsoft.VSCode': 'coding',
  'com.microsoft.VSCodeInsiders': 'coding',
  'com.todesktop.230313mzl4w4u92': 'coding', // Cursor
  'dev.zed.Zed': 'coding',
  'com.sublimetext.4': 'coding',
  'com.googlecode.iterm2': 'coding',
  'com.apple.Terminal': 'coding',
  'com.github.wez.wezterm': 'coding',
  'com.mitchellh.ghostty': 'coding',
  'com.apple.FinalCut': 'video-editing',
  'com.apple.iMovieApp': 'video-editing',
  'com.blackmagic-design.DaVinciResolve': 'video-editing',
  'com.figma.Desktop': 'design',
  'com.bohemiancoding.sketch3': 'design',
  'com.adobe.illustrator': 'design',
  'com.apple.logic10': 'audio-production',
  'com.apple.garageband10': 'audio-production',
  'com.apple.iWork.Pages': 'writing',
  'com.apple.iWork.Keynote': 'planning',
  'com.microsoft.Word': 'writing',
  'com.microsoft.Powerpoint': 'planning',
  'com.literatureandlatte.scrivener3': 'writing',
  'com.ulyssesapp.mac': 'writing',
  'md.obsidian': 'writing',
  'notion.id': 'planning',
  'com.culturedcode.ThingsMac': 'planning',
  'com.omnigroup.OmniFocus3': 'planning',
  'net.ankiweb.dtop': 'learning',
  'com.tinyspeck.slackmacgap': 'communication',
  'com.microsoft.teams2': 'communication',
  'us.zoom.xos': 'communication',
  'com.apple.mail': 'communication',
  'com.hnc.Discord': 'communication',
};

/** Vendors that version their bundle ids (e.g. `com.adobe.PremierePro.25`). */
const PREFIXES: readonly (readonly [string, Category])[] = [
  ['com.jetbrains.', 'coding'],
  ['com.adobe.PremierePro', 'video-editing'],
  ['com.adobe.AfterEffects', 'video-editing'],
  ['com.adobe.Photoshop', 'design'],
  ['com.adobe.LightroomClassic', 'design'],
  ['com.seriflabs.affinity', 'design'],
  ['com.ableton.live', 'audio-production'],
];

export function suggestCategory(appId: string): Category | undefined {
  return EXACT[appId] ?? PREFIXES.find(([prefix]) => appId.startsWith(prefix))?.[1];
}

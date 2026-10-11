// The whole worker side of byok: one call. Keys, tokens and sign-in state stay here.
import { registerAiHandlers } from './lib/background/index.js';
import { reopenAfterReload } from './dev.js';

registerAiHandlers({ prefix: 'byokdemo', settingsHint: 'Add a connection in the demo.' });

// The toolbar button opens the demo in a tab: a popup would close, and stop
// polling, as soon as a sign-in page opens.
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
});

// `npm run dev` reloads the extension on a worker change; this brings the page back.
void reopenAfterReload();

console.log("RedactVision Agent: Service Worker Loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.log("RedactVision Agent: Installed successfully.");
});

/**
 * The in-page panel is now handled directly by the content script.
 * No need to open chrome-extension:// windows here.
 */

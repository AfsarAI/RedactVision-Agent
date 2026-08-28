console.log("RedactVision Agent: Service Worker Loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.log("RedactVision Agent installed successfully.");
});
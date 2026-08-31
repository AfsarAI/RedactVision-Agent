/**
 * RedactVision Agent — Popup Dashboard Controller
 *
 * The toolbar popup is a *settings dashboard*, not a chat. The chat
 * lives in the floating in-page widget. This controller wires:
 *
 *   - Active toggle (master switch)
 *   - Show floating widget toggle
 *   - Auto-redact toggle
 *   - 4-mode routing pill (AUTO / SERVER / ON-DEVICE / LOCAL)
 *   - Server URL field
 *   - Test connection button
 *   - Domain whitelist (add / remove chips)
 *   - Theme (DARK / LIGHT / AUTO)
 *   - Auto-save on any change + a "Done" button to close
 *
 * Persistence is via chrome.storage.local under:
 *   - "rv_agent_config"        — PlannerConfig (serverUrl, onDeviceModel, backend)
 *   - "rv_dashboard_settings"  — everything else (toggles, theme, whitelist)
 *
 * NO API key is held or persisted. Provider keys live in server/.env.
 */

import {
  loadPlannerConfig,
  savePlannerConfig,
  PlannerConfig,
} from "../llm/llm-planner";
import { pingServer } from "../llm/extension-bridge";

interface DashboardSettings {
  active: boolean;
  showWidget: boolean;
  autoRedact: boolean;
  theme: "dark" | "light" | "auto";
  domainWhitelist: string[];
}

const DEFAULT_DASHBOARD: DashboardSettings = {
  active: true,
  showWidget: true,
  autoRedact: true,
  theme: "dark",
  domainWhitelist: [],
};

const STORAGE_KEY = "rv_dashboard_settings";

async function loadDashboard(): Promise<DashboardSettings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const s = stored?.[STORAGE_KEY] as Partial<DashboardSettings> | undefined;
    if (!s) return { ...DEFAULT_DASHBOARD };
    return {
      active: s.active !== false,
      showWidget: s.showWidget !== false,
      autoRedact: s.autoRedact !== false,
      theme: s.theme === "light" || s.theme === "auto" ? s.theme : "dark",
      domainWhitelist: Array.isArray(s.domainWhitelist)
        ? s.domainWhitelist.filter((d): d is string => typeof d === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_DASHBOARD };
  }
}

async function saveDashboard(settings: DashboardSettings): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  } catch {
    /* ignore */
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const $ = <T extends HTMLElement>(id: string): T | null => {
    try {
      const el = document.getElementById(id);
      return el as T | null;
    } catch {
      return null;
    }
  };

  // Element refs - with null checks to prevent uncaught exceptions
  const activeToggle = $<HTMLInputElement>("rv-active-toggle");
  const showWidgetToggle = $<HTMLInputElement>("rv-show-widget");
  const autoRedactToggle = $<HTMLInputElement>("rv-auto-redact");
  const serverUrlInput = $<HTMLInputElement>("rv-server-url");
  const testConnBtn = $<HTMLButtonElement>("rv-test-conn");
  const testResult = $("rv-test-result");
  const domainChips = $("rv-domain-chips");
  const domainForm = $<HTMLFormElement>("rv-domain-form");
  const domainInput = $<HTMLInputElement>("rv-domain-input");
  const doneBtn = $<HTMLButtonElement>("rv-done-btn");
  const statusLabel = $("rv-status-label");
  const statusDot = document.querySelector<HTMLElement>(".rv-status-dot");

  // Guard: if critical elements are missing, log and exit gracefully
  if (!activeToggle || !showWidgetToggle || !autoRedactToggle || !serverUrlInput ||
      !testConnBtn || !testResult || !domainChips || !domainForm || !domainInput ||
      !doneBtn || !statusLabel) {
    console.error("[RedactVision] Popup: Required DOM elements missing, dashboard cannot initialize");
    return;
  }

  // Load persisted state
  const plannerConfig: PlannerConfig = await loadPlannerConfig();
  const settings: DashboardSettings = await loadDashboard();

  // ----- Hydrate UI -----

  activeToggle.checked = settings.active;
  showWidgetToggle.checked = settings.showWidget;
  autoRedactToggle.checked = settings.autoRedact;
  serverUrlInput.value =
    plannerConfig.serverUrl || "http://127.0.0.1:8001";

  // Theme
  document.querySelectorAll<HTMLInputElement>('input[name="rv-theme"]').forEach((r) => {
    r.checked = r.value === settings.theme;
  });
  applyPopupTheme(settings.theme);

  // Domain chips
  renderDomainChips(settings.domainWhitelist, domainChips, async (newList) => {
    settings.domainWhitelist = newList;
    await saveDashboard(settings);
    setStatus("Settings saved");
  });

  // ----- Auto-save wiring -----

  // Helper: persist planner config + show a brief "saved" hint.
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  function setStatus(text: string, kind: "ok" | "busy" | "error" = "ok"): void {
    if (statusLabel) statusLabel.textContent = text;
    if (statusDot) {
      statusDot.className = `rv-status-dot rv-${kind}`;
    }
    if (statusTimer) clearTimeout(statusTimer);
    if (kind === "ok") {
      statusTimer = setTimeout(() => {
        if (statusLabel) statusLabel.textContent = "Settings saved automatically";
        if (statusDot) {
          statusDot.className = "rv-status-dot rv-ok";
        }
      }, 1500);
    }
  }

  async function persistPlanner(): Promise<void> {
    const cfg: PlannerConfig = {
      serverUrl: serverUrlInput?.value.trim() || "http://127.0.0.1:8001",
      onDeviceModel: plannerConfig.onDeviceModel,
      backend: "server",
    };
    await savePlannerConfig(cfg);
    setStatus("Settings saved");
  }

  /** Push updated settings to every open content script. */
  async function broadcastSettingsUpdate(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          chrome.tabs.sendMessage(tab.id, { type: "RV_SETTINGS_UPDATED" }).catch(() => undefined);
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** Apply the theme to the popup itself (body class → CSS vars). */
  function applyPopupTheme(theme: "dark" | "light" | "auto"): void {
    const light =
      theme === "light" ||
      (theme === "auto" && window.matchMedia("(prefers-color-scheme: light)").matches);
    document.body.classList.toggle("rv-light", light);
  }

  // Toggles
  activeToggle.addEventListener("change", async () => {
    settings.active = activeToggle.checked;
    await saveDashboard(settings);
    await broadcastSettingsUpdate();
    setStatus(settings.active ? "Agent enabled" : "Agent paused");
  });

  showWidgetToggle.addEventListener("change", async () => {
    settings.showWidget = showWidgetToggle.checked;
    await saveDashboard(settings);
    await broadcastSettingsUpdate();
    setStatus(settings.showWidget ? "Widget will appear" : "Widget hidden");
  });

  autoRedactToggle.addEventListener("change", async () => {
    settings.autoRedact = autoRedactToggle.checked;
    await saveDashboard(settings);
    await broadcastSettingsUpdate();
    setStatus(settings.autoRedact ? "Auto-redact on" : "Auto-redact off");
  });

  // Server URL — debounced
  let urlTimer: ReturnType<typeof setTimeout> | null = null;
  serverUrlInput.addEventListener("input", () => {
    if (urlTimer) clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      void persistPlanner();
    }, 500);
  });

  // Test connection
  testConnBtn.addEventListener("click", async () => {
    setStatus("Testing connection…", "busy");
    testConnBtn.disabled = true;
    testResult.textContent = "";
    testResult.className = "rv-test-result";
    try {
      const url = serverUrlInput.value.trim() || "http://127.0.0.1:8001";
      const result = await pingServer(url);
      if (result.ok) {
        const data = result.body as
          | {
              configured?: boolean;
              model?: string;
              providers?: Array<{ name: string; available: boolean }>;
            }
          | null;
        const available = (data?.providers || []).filter((p) => p.available);
        const isConfigured = data?.configured === true || available.length > 0;
        if (isConfigured) {
          const names = available.length
            ? available.map((p) => p.name).join(", ")
            : data?.model || "ready";
          testResult.textContent = `✓ Server ready (${names})`;
          testResult.className = "rv-test-result rv-ok";
          setStatus("Server reachable", "ok");
        } else {
          testResult.innerHTML = `✗ Server reachable but no provider API key set. Add one in <code>server/.env</code>.`;
          testResult.className = "rv-test-result rv-fail";
          setStatus("No provider key on server", "error");
        }
      } else {
        testResult.innerHTML = `✗ ${escapeHtml(result.error || `HTTP ${result.status}`)}.<br><small>Start the server: <code>cd server && source ../.venv/bin/activate && python -m uvicorn redactvision_server.main:app --port 8001</code></small>`;
        testResult.className = "rv-test-result rv-fail";
        setStatus("Server unreachable", "error");
      }
    } catch (e) {
      testResult.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
      testResult.className = "rv-test-result rv-fail";
      setStatus("Test failed", "error");
    } finally {
      testConnBtn.disabled = false;
    }
  });

  // Domain whitelist
  domainForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = domainInput.value.trim().toLowerCase();
    // Strip protocol / path — we only store bare hostnames.
    const cleaned = raw
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .trim();
    if (!cleaned) return;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned) && cleaned !== "localhost") {
      domainInput.focus();
      domainInput.select();
      setStatus("Invalid hostname", "error");
      return;
    }
    if (settings.domainWhitelist.includes(cleaned)) {
      domainInput.value = "";
      return;
    }
    settings.domainWhitelist = [...settings.domainWhitelist, cleaned];
    await saveDashboard(settings);
    domainInput.value = "";
    renderDomainChips(settings.domainWhitelist, domainChips, async (newList) => {
      settings.domainWhitelist = newList;
      await saveDashboard(settings);
      setStatus("Settings saved");
    });
    setStatus("Domain added");
  });

  // Theme
  document.querySelectorAll<HTMLInputElement>('input[name="rv-theme"]').forEach((r) => {
    r.addEventListener("change", async () => {
      if (r.checked) {
        settings.theme = r.value as "dark" | "light" | "auto";
        await saveDashboard(settings);
        applyPopupTheme(settings.theme);
        await broadcastSettingsUpdate();
        setStatus("Theme updated");
      }
    });
  });

  // Done button — close the popup.
  doneBtn.addEventListener("click", () => {
    window.close();
  });
});

function renderDomainChips(
  list: string[],
  container: HTMLElement,
  onChange: (newList: string[]) => Promise<void> | void
): void {
  container.innerHTML = "";
  for (const domain of list) {
    const chip = document.createElement("span");
    chip.className = "rv-chip";
    chip.innerHTML = `
      <span>${escapeHtml(domain)}</span>
      <button class="rv-chip-remove" type="button" aria-label="Remove ${escapeHtml(domain)}">×</button>
    `;
    const removeBtn = chip.querySelector(".rv-chip-remove") as HTMLButtonElement;
    removeBtn.addEventListener("click", () => {
      void onChange(list.filter((d) => d !== domain));
    });
    container.appendChild(chip);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

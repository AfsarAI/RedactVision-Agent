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
import {
  getSelectedProfile,
  getSelectedProfileId,
  loadLocalProfiles,
  removeLocalProfile,
  saveLocalProfiles,
  setSelectedProfileId,
  type LocalProfileEntry,
  type LocalProfileValues,
  normalizeFieldKey,
  upsertLocalProfile,
} from "../privacy/profile-store";

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
  const statusDot = document.querySelector(".rv-status-dot") as HTMLElement;
  const profileForm = $<HTMLFormElement>("rv-profile-form");
  const profileNameInput = $<HTMLInputElement>("rv-profile-name");
  const profileEmailInput = $<HTMLInputElement>("rv-profile-email");
  const profilePhoneInput = $<HTMLInputElement>("rv-profile-phone");
  const profileAddressInput = $<HTMLInputElement>("rv-profile-address");
  const profileCustomKeyInput = $<HTMLInputElement>("rv-profile-custom-key");
  const profileCustomValueInput = $<HTMLInputElement>("rv-profile-custom-value");
  const profileList = $("rv-profile-list");
  const localProfileStatus = $("rv-local-profile-status");
  const localModelStatus = $("rv-local-model-status");

  async function renderLocalAIStatus(): Promise<void> {
    localProfileStatus.textContent = "Ready";
    localProfileStatus.className = "rv-local-ai-chip rv-ok";

    try {
      const mod = await import(/* @vite-ignore */ "@huggingface/transformers" as string);
      if (mod && typeof mod.pipeline === "function") {
        localModelStatus.textContent = "Installed";
        localModelStatus.className = "rv-local-ai-chip rv-ok";
      } else {
        localModelStatus.textContent = "Unavailable";
        localModelStatus.className = "rv-local-ai-chip rv-warn";
      }
    } catch {
      localModelStatus.textContent = "Optional";
      localModelStatus.className = "rv-local-ai-chip rv-warn";
    }
  }

  function renderProfileLabel(values: LocalProfileValues): string {
    if (values.name) return values.name;
    if (values.email) return values.email;
    if (values.phone) return values.phone;
    return "Saved profile";
  }

  function renderFieldPills(values: LocalProfileValues): string[] {
    const pills: string[] = [];
    const preferred = ["name", "email", "phone", "address"];
    for (const field of preferred) {
      if (values[field]) pills.push(`${formatFieldName(field)}: ${values[field]}`);
    }
    for (const [field, value] of Object.entries(values)) {
      if (preferred.includes(field) || !value) continue;
      pills.push(`${formatFieldName(field)}: ${value}`);
    }
    return pills.slice(0, 6);
  }

  async function renderProfiles(): Promise<void> {
    const profiles = await loadLocalProfiles();
    const selectedProfileId = await getSelectedProfileId();

    if (profiles.length === 0) {
      profileList.innerHTML = `
        <div class="rv-empty-profiles">
          No saved personal profiles yet. Add your details above to keep them on-device only.
        </div>
      `;
      return;
    }

    profileList.innerHTML = profiles
      .map((profile) => {
        const isSelected = profile.id === selectedProfileId;
        const pills = renderFieldPills(profile.values)
          .map((pill) => `<span class="rv-profile-pill">${escapeHtml(pill)}</span>`)
          .join("");

        return `
          <div class="rv-profile-card ${isSelected ? "active" : ""}">
            <div class="rv-profile-header">
              <div class="rv-profile-name">${escapeHtml(renderProfileLabel(profile.values))}</div>
              ${isSelected ? '<span class="rv-profile-badge">Selected</span>' : ""}
            </div>
            <div class="rv-profile-details">${pills || '<span class="rv-profile-pill">No visible fields saved</span>'}</div>
            <div class="rv-profile-actions">
              <label class="rv-profile-select">
                <input type="radio" name="rv-selected-profile" value="${profile.id}" ${isSelected ? "checked" : ""} />
                <span>Use this profile</span>
              </label>
              <div style="display:flex; gap:6px; align-items:center;">
                <button type="button" class="rv-profile-form-apply" data-apply-profile="${profile.id}">Use for form</button>
                <button type="button" class="rv-profile-delete" data-delete-profile="${profile.id}">Delete</button>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    profileList.querySelectorAll<HTMLInputElement>('input[name="rv-selected-profile"]').forEach((radio) => {
      radio.addEventListener("change", async () => {
        if (radio.checked) {
          await setSelectedProfileId(radio.value);
          await renderProfiles();
          setStatus("Profile selected");
        }
      });
    });

    profileList.querySelectorAll<HTMLButtonElement>("[data-apply-profile]").forEach((button) => {
      button.addEventListener("click", async () => {
        const profileId = button.dataset.applyProfile || "";
        if (!profileId) return;
        await setSelectedProfileId(profileId);
        await renderProfiles();
        setStatus("Profile selected for form fill");
      });
    });

    profileList.querySelectorAll<HTMLButtonElement>("[data-delete-profile]").forEach((button) => {
      button.addEventListener("click", async () => {
        await removeLocalProfile(button.dataset.deleteProfile || "");
        await renderProfiles();
        setStatus("Profile removed");
      });
    });
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

  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const values: LocalProfileValues = {
      name: profileNameInput.value.trim() || undefined,
      email: profileEmailInput.value.trim() || undefined,
      phone: profilePhoneInput.value.trim() || undefined,
      address: profileAddressInput.value.trim() || undefined,
    };
    const customKey = normalizeFieldKey(profileCustomKeyInput.value);
    const customValue = profileCustomValueInput.value.trim();
    if (profileCustomKeyInput.value.trim() && customValue) {
      values[customKey] = customValue;
    }

    const hasAnyValue = Object.values(values).some((value) => !!value);
    if (!hasAnyValue) {
      setStatus("Add at least one field", "error");
      return;
    }

    const profile: LocalProfileEntry = {
      id: `profile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      label: renderProfileLabel(values),
      createdAt: Date.now(),
      values,
    };

    await upsertLocalProfile(profile);
    await setSelectedProfileId(profile.id);
    profileForm.reset();
    await renderProfiles();
    setStatus("Profile saved locally");
  });

  await renderProfiles();
  await renderLocalAIStatus();

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

function formatFieldName(field: string): string {
  return field
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

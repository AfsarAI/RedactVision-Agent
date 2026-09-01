/**
 * RedactVision Agent — Fan-Out Subagent Orchestrator
 *
 * Decomposes complex multi-site/multi-tab user requests into parallel subagent
 * tasks, manages worker tabs, coordinates local privacy sanitization across
 * tabs, and aggregates findings into a unified result.
 */

import {
  FanOutPlan,
  FanOutOutcome,
  SubagentTask,
  SubagentResultSummary,
  SubagentProgressEvent,
} from "./subagent-types";

export interface SubagentOrchestratorCallbacks {
  onSubagentEvent?: (event: SubagentProgressEvent) => void;
  onPlanCreated?: (plan: FanOutPlan) => void;
}

export class SubagentOrchestrator {
  private callbacks: SubagentOrchestratorCallbacks;

  constructor(callbacks: SubagentOrchestratorCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Determine if a user prompt is a multi-tab or fan-out request,
   * and decompose it into distinct subagent tasks.
   */
  decomposePrompt(prompt: string, currentUrl = window.location.href): FanOutPlan {
    const lower = prompt.toLowerCase();

    // Check for fan-out keywords or multi-site patterns
    const isExplicitFanOut =
      lower.includes("fan out") ||
      lower.includes("fanout") ||
      lower.includes("in parallel") ||
      lower.includes("across multiple") ||
      lower.includes("open tabs") ||
      lower.includes("all tabs") ||
      lower.includes("open new tab");

    // Multi-site patterns (e.g. "on google and amazon", "at google, amazon, and microsoft")
    const sitesMatch = this.extractTargetSites(prompt);

    if (!isExplicitFanOut && sitesMatch.length < 2) {
      return {
        isFanOut: false,
        objective: prompt,
        subagents: [],
      };
    }

    const subagents: SubagentTask[] = [];

    if (sitesMatch.length >= 2) {
      // Fan out per detected target website
      sitesMatch.forEach((site, index) => {
        const subId = `subagent-${Date.now()}-${index + 1}`;
        subagents.push({
          id: subId,
          label: site.name,
          url: site.url,
          prompt: `${prompt} on ${site.name}`,
          status: "pending",
        });
      });
    } else {
      // Deconstruct into 2-3 logical parallel subtasks
      const subId1 = `subagent-${Date.now()}-1`;
      const subId2 = `subagent-${Date.now()}-2`;
      subagents.push(
        {
          id: subId1,
          label: "Task 1",
          url: currentUrl,
          prompt: prompt,
          status: "pending",
        },
        {
          id: subId2,
          label: "Task 2 (New Tab)",
          url: "https://google.com",
          prompt: prompt,
          status: "pending",
        }
      );
    }

    const plan: FanOutPlan = {
      isFanOut: true,
      objective: prompt,
      subagents,
      maxConcurrency: 3,
    };

    this.callbacks.onPlanCreated?.(plan);
    return plan;
  }

  /**
   * Execute a fan-out plan across background/worker tabs concurrently.
   */
  async executeFanOut(plan: FanOutPlan): Promise<FanOutOutcome> {
    const startTime = performance.now();
    const results: SubagentResultSummary[] = [];
    const concurrency = plan.maxConcurrency || 3;

    console.log(`[SubagentOrchestrator] Starting Fan-Out with ${plan.subagents.length} subagents`);

    // Process subagents with concurrency limit
    const queue = [...plan.subagents];
    const inProgress: Promise<void>[] = [];

    while (queue.length > 0 || inProgress.length > 0) {
      while (inProgress.length < concurrency && queue.length > 0) {
        const task = queue.shift()!;
        const workerPromise = this.runSingleSubagent(task).then((summary) => {
          results.push(summary);
          const idx = inProgress.indexOf(workerPromise);
          if (idx !== -1) inProgress.splice(idx, 1);
        });
        inProgress.push(workerPromise);
      }

      if (inProgress.length > 0) {
        await Promise.race(inProgress);
      }
    }

    const durationMs = performance.now() - startTime;
    const completedCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    // Synthesize final report
    const synthesizedReport = this.synthesizeResults(plan.objective, results);

    return {
      objective: plan.objective,
      totalSubagents: plan.subagents.length,
      completedCount,
      failedCount,
      results,
      durationMs,
      synthesizedReport,
    };
  }

  /**
   * Run a single subagent: creates tab, runs prompt, records outcome, and closes tab.
   */
  private async runSingleSubagent(task: SubagentTask): Promise<SubagentResultSummary> {
    const subStartTime = performance.now();
    task.status = "spawning";
    task.startTime = Date.now();

    this.emitEvent({
      subagentId: task.id,
      status: "spawning",
      actionText: `Spawning subagent for ${task.label}`,
      detail: `Opening tab: ${task.url}`,
    });

    let tabId: number | undefined;

    try {
      // 1. Open background tab
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        const openResp = (await chrome.runtime.sendMessage({
          type: "RV_OPEN_TAB",
          url: task.url,
          active: false,
        })) as { ok: boolean; tabId?: number };

        if (openResp?.ok && openResp.tabId) {
          tabId = openResp.tabId;
          task.tabId = tabId;
        }
      }

      task.status = "running";
      this.emitEvent({
        subagentId: task.id,
        status: "running",
        actionText: `Subagent running on ${task.label}`,
        detail: `Executing prompt in tab #${tabId || "local"}`,
      });

      // 2. Dispatch prompt to subagent on that tab
      let outcomeMessage = `Task executed successfully on ${task.label}`;
      let actionsCount = 1;

      if (tabId && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        const runResp = (await chrome.runtime.sendMessage({
          type: "RV_RUN_SUBAGENT_TAB",
          tabId,
          prompt: task.prompt,
        })) as { ok: boolean; result?: { actionsExecuted?: number; reason?: string } };

        if (runResp?.ok && runResp.result) {
          actionsCount = runResp.result.actionsExecuted || 1;
          outcomeMessage = runResp.result.reason || outcomeMessage;
        }
      } else {
        // Simulated execution delay if non-extension mode
        await new Promise((r) => setTimeout(r, 1200));
      }

      task.status = "completed";
      task.resultMessage = outcomeMessage;
      task.actionsCount = actionsCount;

      this.emitEvent({
        subagentId: task.id,
        status: "completed",
        actionText: `Subagent completed: ${task.label}`,
        detail: outcomeMessage,
      });

      const subDuration = performance.now() - subStartTime;
      return {
        subagentId: task.id,
        label: task.label,
        url: task.url,
        success: true,
        summary: outcomeMessage,
        actionsExecuted: actionsCount,
        durationMs: subDuration,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      task.status = "failed";
      task.error = errMsg;

      this.emitEvent({
        subagentId: task.id,
        status: "failed",
        actionText: `Subagent failed on ${task.label}`,
        detail: errMsg,
      });

      const subDuration = performance.now() - subStartTime;
      return {
        subagentId: task.id,
        label: task.label,
        url: task.url,
        success: false,
        summary: `Failed: ${errMsg}`,
        actionsExecuted: 0,
        durationMs: subDuration,
      };
    } finally {
      // 3. Clean up worker tab if created
      if (tabId && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: "RV_CLOSE_TAB",
          tabId,
        }).catch(() => {});
      }
    }
  }

  private emitEvent(event: SubagentProgressEvent): void {
    this.callbacks.onSubagentEvent?.(event);
  }

  /**
   * Helper to identify company/service targets in natural language prompts.
   */
  private extractTargetSites(prompt: string): Array<{ name: string; url: string }> {
    const KNOWN_SITES: Record<string, { name: string; url: string }> = {
      google: { name: "Google", url: "https://www.google.com" },
      amazon: { name: "Amazon", url: "https://www.amazon.com" },
      microsoft: { name: "Microsoft", url: "https://www.microsoft.com" },
      linkedin: { name: "LinkedIn", url: "https://www.linkedin.com" },
      github: { name: "GitHub", url: "https://github.com" },
      chatgpt: { name: "ChatGPT", url: "https://chatgpt.com" },
      netflix: { name: "Netflix", url: "https://www.netflix.com" },
      apple: { name: "Apple", url: "https://www.apple.com" },
      meta: { name: "Meta", url: "https://about.meta.com" },
      uber: { name: "Uber", url: "https://www.uber.com" },
    };

    const found: Array<{ name: string; url: string }> = [];
    const lower = prompt.toLowerCase();

    for (const [key, site] of Object.entries(KNOWN_SITES)) {
      if (lower.includes(key)) {
        found.push(site);
      }
    }

    return found;
  }

  /**
   * Synthesize subagent results into a coherent final summary.
   */
  private synthesizeResults(objective: string, results: SubagentResultSummary[]): string {
    const successCount = results.filter((r) => r.success).length;
    let report = `### Fan-Out Subagents Completed (${successCount}/${results.length} succeeded)\n\n`;
    report += `**Objective:** ${objective}\n\n`;

    results.forEach((r, idx) => {
      const icon = r.success ? "✅" : "❌";
      report += `${idx + 1}. ${icon} **${r.label}** (${r.url})\n`;
      report += `   - *Status:* ${r.summary}\n`;
      report += `   - *Actions:* ${r.actionsExecuted} executed in ${(r.durationMs / 1000).toFixed(1)}s\n\n`;
    });

    return report;
  }
}

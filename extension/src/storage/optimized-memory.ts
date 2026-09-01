/**
 * RedactVision Agent — Incremental Storage & In-Memory Cache
 *
 * Eliminates repetitive chrome.storage.local I/O lag by maintaining
 * an in-memory runtime cache and writing updates incrementally.
 */

export interface ConversationTurn {
  prompt: string;
  actionSummary?: string;
  result?: unknown;
  timestamp: number;
}

export interface SessionRecord {
  createdAt: number;
  lastUpdated: number;
  conversationHistory: ConversationTurn[];
}

export class OptimizedAgentMemory {
  private static memoryCache: Record<string, SessionRecord> | null = null;
  private static isPersisting = false;
  private static pendingSaves = new Set<string>();

  /**
   * Retrieves the in-memory cache, loading from storage only on initial access.
   */
  static async getCache(): Promise<Record<string, SessionRecord>> {
    if (!this.memoryCache) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        try {
          const data = await chrome.storage.local.get("agent_sessions");
          this.memoryCache = (data.agent_sessions as Record<string, SessionRecord>) || {};
        } catch {
          this.memoryCache = {};
        }
      } else {
        this.memoryCache = {};
      }
    }
    return this.memoryCache;
  }

  /**
   * Appends a conversation turn incrementally with in-memory caching and async storage write.
   */
  static async appendTurnIncremental(
    sessionId: string,
    turnData: { prompt: string; actionSummary?: string; result?: unknown }
  ): Promise<void> {
    const cache = await this.getCache();

    if (!cache[sessionId]) {
      cache[sessionId] = {
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        conversationHistory: [],
      };
    }

    cache[sessionId].conversationHistory.push({
      ...turnData,
      timestamp: Date.now(),
    });
    cache[sessionId].lastUpdated = Date.now();

    // Cap history size to prevent unbounded memory growth
    if (cache[sessionId].conversationHistory.length > 50) {
      cache[sessionId].conversationHistory = cache[sessionId].conversationHistory.slice(-50);
    }

    this.pendingSaves.add(sessionId);
    this.scheduleAsyncPersist();
  }

  /**
   * Get an existing session record from memory cache.
   */
  static async getSession(sessionId: string): Promise<SessionRecord | null> {
    const cache = await this.getCache();
    return cache[sessionId] || null;
  }

  /**
   * Asynchronously batch writes dirty sessions to storage.
   */
  private static scheduleAsyncPersist(): void {
    if (this.isPersisting || typeof chrome === "undefined" || !chrome.storage?.local) return;

    this.isPersisting = true;
    setTimeout(async () => {
      try {
        if (this.memoryCache && this.pendingSaves.size > 0) {
          this.pendingSaves.clear();
          await chrome.storage.local.set({ agent_sessions: this.memoryCache });
        }
      } catch (err) {
        console.warn("[OptimizedMemory] Async persist error:", err);
      } finally {
        this.isPersisting = false;
      }
    }, 100);
  }

  static clearCache(): void {
    this.memoryCache = null;
    this.pendingSaves.clear();
  }
}

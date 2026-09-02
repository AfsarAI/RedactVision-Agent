/**
 * RedactVision Agent - Server Communication Module
 *
 * Phase 7: Secure client/server transport via WebSocket.
 *
 * Privacy contract:
 * - NEVER send token map to server
 * - NEVER send raw PII (emails, phones, passwords, names)
 * - Only send sanitized DOM with semantic tokens
 * - Validate all server actions before execution
 */

export interface ServerConfig {
  url: string;
  reconnectAttempts: number;
  reconnectDelay: number;
}

export interface ServerAction {
  action: "click" | "type" | "scroll" | "navigate" | "wait";
  target: string;
  confidence: number;
  value?: string;
  metadata?: Record<string, unknown>;
}

export interface ServerMessage {
  type: "status" | "action" | "error";
  data?: unknown;
  error?: string;
}

export interface SanitizedPayload {
  url: string;
  title: string;
  elements: unknown[];
  prompt?: string;
  timestamp: number;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "reconnecting";

export interface ServerConnectionCallbacks {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onAction?: (action: ServerAction) => void;
  onError?: (error: string) => void;
  onStateChange?: (state: ConnectionState) => void;
}

export class ServerConnection {
  private ws: WebSocket | null = null;
  private config: ServerConfig;
  private callbacks: ServerConnectionCallbacks;
  private state: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimeout: number | null = null;
  private intentionalDisconnect = false;

  constructor(config: ServerConfig, callbacks: ServerConnectionCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Connect to the server WebSocket.
   */
  connect(): void {
    if (this.state === "connected" || this.state === "connecting") {
      console.warn("[ServerConnection] Already connected or connecting");
      return;
    }

    // Reset intentional disconnect flag
    this.intentionalDisconnect = false;
    this.setState("connecting");

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        console.log("[ServerConnection] Connected to server");
        this.setState("connected");
        this.reconnectAttempt = 0;
        this.callbacks.onConnected?.();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error("[ServerConnection] WebSocket error:", error);
        this.setState("error");
        this.callbacks.onError?.("WebSocket connection error");
      };

      this.ws.onclose = () => {
        console.log("[ServerConnection] Connection closed");

        // Only attempt reconnect if NOT intentionally disconnected
        if (!this.intentionalDisconnect) {
          this.setState("disconnected");
          this.callbacks.onDisconnected?.();
          this.attemptReconnect();
        } else {
          this.setState("disconnected");
        }
      };
    } catch (error) {
      console.error("[ServerConnection] Failed to create WebSocket:", error);
      this.setState("error");
      this.callbacks.onError?.(`Connection failed: ${error}`);
    }
  }

/**
   * Disconnect from the server.
   */
  disconnect(): void {
    // Set intentional disconnect flag to prevent reconnect
    this.intentionalDisconnect = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      // Remove event listeners to prevent onclose from firing
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.setState("disconnected");
  }

  /**
   * Send sanitized page context to server for reasoning.
   *
   * IMPORTANT: This payload must NEVER contain:
   * - token map
   * - raw PII (original emails, phones, passwords, names)
   *
   * Only sanitized elements with semantic tokens are sent.
   */
  async sendSanitizedContext(payload: SanitizedPayload): Promise<void> {
    if (!this.ws || this.state !== "connected") {
      throw new Error("Not connected to server");
    }

    // Privacy validation - ensure no token map is being sent
    if ("tokenMap" in payload || "token_map" in payload) {
      throw new Error("Privacy violation: Attempted to send token map to server");
    }

    console.log("[ServerConnection] Sending sanitized context to server");
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.state === "connected";
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.callbacks.onStateChange?.(newState);
    }
  }

  private handleMessage(rawData: string): void {
    try {
      const message = JSON.parse(rawData) as ServerMessage;

      switch (message.type) {
        case "status":
          console.log("[ServerConnection] Status:", message.data);
          break;

        case "action":
          if (message.data) {
            const action = message.data as ServerAction;
            console.log("[ServerConnection] Received action:", action);
            this.callbacks.onAction?.(action);
          }
          break;

        case "error":
          console.error("[ServerConnection] Server error:", message.error);
          this.callbacks.onError?.(message.error || "Unknown server error");
          break;

        default:
          console.warn("[ServerConnection] Unknown message type:", message.type);
      }
    } catch (error) {
      console.error("[ServerConnection] Failed to parse message:", error);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempt >= this.config.reconnectAttempts) {
      console.log("[ServerConnection] Max reconnect attempts reached");
      this.setState("error");
      this.callbacks.onError?.("Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempt++;
    this.setState("reconnecting");

    console.log(
      `[ServerConnection] Reconnecting (${this.reconnectAttempt}/${this.config.reconnectAttempts})...`
    );

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect();
    }, this.config.reconnectDelay);
  }
}

/**
 * Create a server connection with default config.
 */
export function createServerConnection(
  callbacks: ServerConnectionCallbacks,
  serverUrl?: string
): ServerConnection {
  const config: ServerConfig = {
    url: serverUrl || "ws://13.49.49.25:8001/ws/agent",
    reconnectAttempts: 3,
    reconnectDelay: 2000,
  };

  return new ServerConnection(config, callbacks);
}

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type {
  WsTopic,
  WsClientMessage,
  WsServerMessage,
  WsPush,
  WsBatchTestProgress,
  WsBatchTestDone,
  WsBatchTestError,
} from "@/lib/ws-types";
import type { ProviderTestResult } from "@/lib/types";

type WsStatus = "connecting" | "connected" | "disconnected";
type PushCallback = (data: unknown) => void;
type InvalidateCallback = (topics: WsTopic[], source?: string) => void;
export type BatchTestProgress = {
  index: number;
  keyId: string;
  result: ProviderTestResult;
};
type BatchTestOnProgress = (progress: BatchTestProgress) => void;

interface WsContextValue {
  status: WsStatus;
  subscribe: (
    topic: WsTopic,
    callback: PushCallback,
    params?: Record<string, string | number | boolean>,
  ) => () => void;
  request: <T = unknown>(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
  ) => Promise<T>;
  onInvalidate: (callback: InvalidateCallback) => () => void;
  startBatchTest: (
    providerId: string,
    keyIds: string[],
    onProgress: BatchTestOnProgress,
  ) => Promise<{ total: number; ok: number }>;
}

const WsContext = createContext<WsContextValue | null>(null);

function useWsContext(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWsContext must be used within <WsProvider>");
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────

const MAX_BACKOFF = 30_000;

export function WsProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);

  // topic → Set<callback>
  const pushHandlers = useRef(new Map<WsTopic, Set<PushCallback>>());
  // request id → { resolve, reject, timer }
  const pendingRequests = useRef(
    new Map<
      string,
      {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  // invalidation callbacks
  const invalidateHandlers = useRef(new Set<InvalidateCallback>());
  // batch-test id → { onProgress, resolve, reject } — symmetric to
  // pendingRequests, but supports a stream of progress events before the
  // terminal resolve/reject (done/error) instead of a single response.
  const batchTestHandlers = useRef(
    new Map<
      string,
      {
        onProgress: BatchTestOnProgress;
        resolve: (v: { total: number; ok: number }) => void;
        reject: (e: Error) => void;
      }
    >(),
  );

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    const token = localStorage.getItem("gw_admin_token");
    if (!token) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws?token=${token}`;

    setStatus("connecting");
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus("connected");
      backoffRef.current = 1000;

      // Re-subscribe to all active topics
      for (const topic of pushHandlers.current.keys()) {
        if ((pushHandlers.current.get(topic)?.size ?? 0) > 0) {
          send({ type: "subscribe", topic });
        }
      }
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(event.data) as WsServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "ping":
          send({ type: "pong" });
          break;

        case "push": {
          const callbacks = pushHandlers.current.get((msg as WsPush).topic);
          if (callbacks) {
            for (const cb of callbacks) cb((msg as WsPush).data);
          }
          break;
        }

        case "response": {
          const pending = pendingRequests.current.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.current.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.data);
            }
          }
          break;
        }

        case "invalidate":
          for (const cb of invalidateHandlers.current) {
            cb(msg.topics, msg.source);
          }
          break;

        case "batch-test-progress": {
          const p = msg as WsBatchTestProgress;
          batchTestHandlers.current
            .get(p.id)
            ?.onProgress({ index: p.index, keyId: p.keyId, result: p.result });
          break;
        }

        case "batch-test-done": {
          const d = msg as WsBatchTestDone;
          const pending = batchTestHandlers.current.get(d.id);
          if (pending) {
            batchTestHandlers.current.delete(d.id);
            pending.resolve({ total: d.total, ok: d.ok });
          }
          break;
        }

        case "batch-test-error": {
          const e = msg as WsBatchTestError;
          const pending = batchTestHandlers.current.get(e.id);
          if (pending) {
            batchTestHandlers.current.delete(e.id);
            pending.reject(new Error(e.message));
          }
          break;
        }

        case "error":
          console.warn("[ws] server error:", msg.message, msg.code);
          break;
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      wsRef.current = null;
      setStatus("disconnected");

      // Reject all pending requests
      for (const [id, pending] of pendingRequests.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WebSocket closed"));
        pendingRequests.current.delete(id);
      }

      // Reject all in-flight batch tests — the server-side job is gone too
      // (the hub removes the client and its job set on disconnect).
      for (const [id, pending] of batchTestHandlers.current) {
        pending.reject(new Error("WebSocket closed"));
        batchTestHandlers.current.delete(id);
      }

      // Schedule reconnect with exponential backoff
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect is handled there
    };
  }, [send]);

  // Initial connection
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;

      // Clean up pending requests
      for (const [, pending] of pendingRequests.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WsProvider unmounted"));
      }
      pendingRequests.current.clear();

      for (const [, pending] of batchTestHandlers.current) {
        pending.reject(new Error("WsProvider unmounted"));
      }
      batchTestHandlers.current.clear();
    };
  }, [connect]);

  // ── Public API ───────────────────────────────────────────────────

  const subscribeTopic = useCallback(
    (
      topic: WsTopic,
      callback: PushCallback,
      params?: Record<string, string | number | boolean>,
    ): (() => void) => {
      let set = pushHandlers.current.get(topic);
      if (!set) {
        set = new Set();
        pushHandlers.current.set(topic, set);
      }
      const isFirst = set.size === 0;
      set.add(callback);

      if (isFirst) {
        send({ type: "subscribe", topic, params });
      }

      return () => {
        set!.delete(callback);
        if (set!.size === 0) {
          pushHandlers.current.delete(topic);
          send({ type: "unsubscribe", topic });
        }
      };
    },
    [send],
  );

  const request = useCallback(
    <T = unknown,>(
      endpoint: string,
      params?: Record<string, string | number | boolean>,
    ): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingRequests.current.delete(id);
          reject(new Error(`WS request "${endpoint}" timed out after 10s`));
        }, 10_000);

        pendingRequests.current.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });

        send({ type: "request", id, endpoint, params });
      });
    },
    [send],
  );

  const onInvalidate = useCallback(
    (callback: InvalidateCallback): (() => void) => {
      invalidateHandlers.current.add(callback);
      return () => {
        invalidateHandlers.current.delete(callback);
      };
    },
    [],
  );

  const startBatchTest = useCallback(
    (
      providerId: string,
      keyIds: string[],
      onProgress: BatchTestOnProgress,
    ): Promise<{ total: number; ok: number }> => {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        batchTestHandlers.current.set(id, { onProgress, resolve, reject });
        send({ type: "batch-test", id, providerId, keyIds });
      });
    },
    [send],
  );

  const value: WsContextValue = {
    status,
    subscribe: subscribeTopic,
    request,
    onInvalidate,
    startBatchTest,
  };

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

// ── Hooks ────────────────────────────────────────────────────────────

export function useWsSubscription<T = unknown>(
  topic: WsTopic,
  params?: Record<string, string | number | boolean>,
) {
  const { status, subscribe } = useWsContext();
  const [data, setData] = useState<T | null>(null);

  // Stable serialisation of params for the dep array
  const paramsKey = params ? JSON.stringify(params) : "";

  useEffect(() => {
    const parsed = paramsKey ? JSON.parse(paramsKey) : undefined;
    const unsubscribe = subscribe(topic, (d) => setData(d as T), parsed);
    return unsubscribe;
  }, [topic, paramsKey, subscribe]);

  return { data, status };
}

export function useWsStatus() {
  const { status } = useWsContext();
  return { status };
}

export function useWsRequest() {
  const { status, request } = useWsContext();
  return { request, status };
}

export function useWsBatchTest() {
  const { status, startBatchTest } = useWsContext();
  return { startBatchTest, status };
}

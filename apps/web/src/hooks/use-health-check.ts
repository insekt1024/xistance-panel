"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface HealthCheckResult {
  isHealthy: boolean;
  lastChecked: Date | null;
  error: string | null;
}

interface UseHealthCheckOptions {
  interval?: number;
  enabled?: boolean;
}

export function useHealthCheck(options: UseHealthCheckOptions = {}) {
  const { interval = 30000, enabled = true } = options;
  const [state, setState] = useState<HealthCheckResult>({
    isHealthy: true,
    lastChecked: null,
    error: null,
  });
  const abortControllerRef = useRef<AbortController | null>(null);

  const checkHealth = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const res = await fetch("/api/health", {
        signal: abortControllerRef.current.signal,
      });
      const data = await res.json();

      setState({
        isHealthy: data.ok === true,
        lastChecked: new Date(),
        error: null,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setState({
        isHealthy: false,
        lastChecked: new Date(),
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    checkHealth();
    const id = setInterval(() => {
      if (!document.hidden) checkHealth();
    }, interval);

    const onVisibility = () => {
      if (!document.hidden) checkHealth();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      abortControllerRef.current?.abort();
    };
  }, [enabled, interval, checkHealth]);

  return state;
}

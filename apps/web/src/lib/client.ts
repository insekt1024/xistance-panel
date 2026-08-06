"use client";

// Client-side helpers for talking to the panel API.

export function csrfToken(): string {
  const m = /xt_csrf=([^;]+)/.exec(document.cookie);
  return m ? m[1] : "";
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.method && init.method !== "GET" ? { "X-CSRF-Token": csrfToken() } : {}),
      ...init?.headers,
    },
  });
  let data: T = undefined as T;
  try {
    data = (await res.json()) as T;
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, data };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { api, WS_URL, type PriceTick } from "@/lib/api";

export type LivePrice = PriceTick & { direction: "up" | "down" | null };
export type FeedStatus = "connecting" | "live" | "polling" | "offline";

/** Streams prices over WebSocket; falls back to polling the REST endpoint if the socket drops. */
export function usePrices() {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const apply = (tick: PriceTick) =>
      setPrices((prev) => {
        const old = prev[tick.mint];
        const direction = old ? (tick.usd > old.usd ? "up" : tick.usd < old.usd ? "down" : old.direction) : null;
        return { ...prev, [tick.mint]: { ...tick, direction } };
      });

    const poll = async () => {
      try {
        const { prices } = await api.prices();
        prices.forEach(apply);
        setStatus((s) => (s === "live" ? s : "polling"));
      } catch {
        setStatus((s) => (s === "live" ? s : "offline"));
      }
    };

    const connect = () => {
      ws = new WebSocket(`${WS_URL}/v1/prices/stream`);
      ws.onopen = () => {
        retry.current = 0;
        setStatus("live");
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
      };
      ws.onmessage = (e) => {
        try {
          apply(JSON.parse(e.data));
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus("polling");
        if (!pollTimer) pollTimer = setInterval(poll, 5_000);
        const delay = Math.min(1_000 * 2 ** retry.current++, 30_000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    void poll();
    connect();
    return () => {
      closed = true;
      ws?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  return { prices, status };
}

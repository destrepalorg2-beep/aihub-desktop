"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GlobeCdn } from "@/components/ui/cobe-globe-cdn"
import { cn } from "@/lib/utils"

/* ── shapes the API returns ───────────────────────────────────────────────── */

export interface VpnServer {
  id: string
  /** Shown to the operator, e.g. "Германия". */
  name: string
  /** Short tag floated over the globe, e.g. "fra1". */
  region: string
  host: string
  port: number
  /** [latitude, longitude] */
  location: [number, number]
  protocol?: string
  /** Live check, filled in by the server on every poll. */
  online?: boolean
  latencyMs?: number | null
  error?: string | null
}

interface Payload {
  configured: boolean
  configPath?: string
  servers: VpnServer[]
  checkedAt?: string
}

/* ── theme ────────────────────────────────────────────────────────────────── */

/**
 * The globe ships light. This panel is dark, so the sphere is darkened and the
 * markers take the app's accent instead of black, which would vanish into it.
 */
const DARK_GLOBE = {
  dark: 1,
  baseColor: [0.16, 0.16, 0.22] as [number, number, number],
  markerColor: [0.48, 0.46, 1] as [number, number, number],
  glowColor: [0.12, 0.12, 0.18] as [number, number, number],
  arcColor: [0.48, 0.46, 1] as [number, number, number],
  chipText: "#f2f3f5",
  chipBg: "#1a1a2e",
  pyramidFaces: ["#7b76ff", "#5f5ad6", "#453fae", "#6b66e6"] as [string, string, string, string],
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Green under 100 ms, amber to 250, red beyond — the usual reading of a ping. */
function pingTone(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "text-muted-foreground"
  if (ms < 100) return "text-emerald-400"
  if (ms < 250) return "text-amber-400"
  return "text-red-400"
}

function pingBar(ms: number | null | undefined): number {
  if (ms === null || ms === undefined) return 0
  // 0 ms fills the bar, 400 ms empties it. Clamped so an awful link still
  // shows a sliver rather than disappearing.
  return Math.max(4, Math.min(100, Math.round(100 - (ms / 400) * 100)))
}

/* ── component ────────────────────────────────────────────────────────────── */

export default function VpnTracker() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch("http://localhost:3000/api/admin/vpn/servers", {
        headers: { Authorization: `Bearer ${(window as any).ADMIN_TOKEN ?? ""}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      // Keep the last good reading on screen and say it is stale, rather than
      // blanking the panel every time one poll misses.
      setError(e instanceof Error ? e.message : "нет связи с сервером")
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load()
    timer.current = window.setInterval(load, 15000)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [load])

  const servers = data?.servers ?? []

  /* Markers and arcs are derived, and memoised by content: GlobeCdn rebuilds
     the whole WebGL globe whenever these identities change, so a new array on
     every 15-second poll would restart the animation each time. */
  const markerKey = servers.map((s) => `${s.id}:${s.location.join(",")}`).join("|")
  const markers = useMemo(
    () => servers.map((s) => ({ id: s.id, location: s.location, region: s.region })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markerKey]
  )

  /* One arc from the first server to each of the others — enough to read the
     mesh at a glance without drawing every pair. */
  const arcs = useMemo(() => {
    if (servers.length < 2) return []
    const hub = servers[0]
    return servers.slice(1).map((s) => ({
      id: `${hub.id}-${s.id}`,
      from: hub.location,
      to: s.location,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey])

  /* Real ping on the arcs instead of the component's demo traffic ticker. */
  const arcLabels = useMemo(() => {
    const out: Record<string, string> = {}
    if (servers.length < 2) return out
    const hub = servers[0]
    for (const s of servers.slice(1)) {
      out[`${hub.id}-${s.id}`] = s.latencyMs != null ? `${s.latencyMs} ms` : "—"
    }
    return out
  }, [servers])

  const online = servers.filter((s) => s.online).length
  const best = servers
    .filter((s) => s.online && s.latencyMs != null)
    .reduce<VpnServer | null>((a, b) => (!a || (b.latencyMs ?? 1e9) < (a.latencyMs ?? 1e9) ? b : a), null)

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Серверов" value={servers.length || "—"} />
        <Stat label="На связи" value={servers.length ? `${online} из ${servers.length}` : "—"}
              tone={servers.length && online === 0 ? "bad" : online ? "ok" : undefined} />
        <Stat label="Лучший пинг" value={best?.latencyMs != null ? `${best.latencyMs} мс` : "—"}
              sub={best?.name} />
        <Stat label="Проверено" value={data?.checkedAt ? timeOf(data.checkedAt) : "—"}
              sub={error ? "данные устарели" : busy ? "обновляю…" : undefined}
              tone={error ? "bad" : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* Globe */}
        <div className="rounded-xl border border-border bg-card p-4">
          {servers.length ? (
            <GlobeCdn markers={markers} arcs={arcs} arcLabels={arcLabels} theme={DARK_GLOBE} />
          ) : (
            <div className="flex aspect-square items-center justify-center px-8 text-center text-xs text-muted-foreground">
              Серверы пока не добавлены — глобус покажет их, как только появятся адреса.
            </div>
          )}
        </div>

        {/* Server list */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Серверы</h3>
            <button
              onClick={load}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {busy ? "Проверяю…" : "Проверить сейчас"}
            </button>
          </div>

          {!data && !error && <Hint>Загрузка…</Hint>}

          {data && !data.configured && (
            <Hint>
              Список серверов пуст. Добавьте их в файл{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {data.configPath ?? "data/vpn-servers.json"}
              </code>{" "}
              — рядом лежит пример с готовой разметкой, нужно вписать только адреса.
            </Hint>
          )}

          {error && !data && <Hint tone="bad">Не удалось получить список: {error}</Hint>}

          {servers.length > 0 && (
            <ul className="divide-y divide-border">
              {servers.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      s.online ? "bg-emerald-400" : "bg-red-400"
                    )}
                    title={s.online ? "на связи" : s.error ?? "не отвечает"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {s.region}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {s.host}:{s.port}
                      {s.protocol ? ` · ${s.protocol}` : ""}
                    </div>
                  </div>

                  <div className="hidden w-24 shrink-0 sm:block">
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width] duration-500",
                          s.online ? "bg-primary" : "bg-transparent"
                        )}
                        style={{ width: `${pingBar(s.latencyMs)}%` }}
                      />
                    </div>
                  </div>

                  <div className={cn("w-16 shrink-0 text-right font-mono text-sm tabular-nums", pingTone(s.latencyMs))}>
                    {s.online && s.latencyMs != null ? `${s.latencyMs}` : "—"}
                    {s.online && s.latencyMs != null && (
                      <span className="ml-0.5 text-[10px] text-muted-foreground">мс</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── small pieces ─────────────────────────────────────────────────────────── */

function Stat({
  label, value, sub, tone,
}: { label: string; value: React.ReactNode; sub?: string; tone?: "ok" | "bad" }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn(
        "mt-1 text-xl font-semibold tabular-nums",
        tone === "ok" && "text-emerald-400",
        tone === "bad" && "text-red-400"
      )}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "bad" }) {
  return (
    <p className={cn(
      "px-4 py-6 text-xs leading-relaxed",
      tone === "bad" ? "text-red-400" : "text-muted-foreground"
    )}>
      {children}
    </p>
  )
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? "—"
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

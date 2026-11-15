"use client";

import { useEffect, useRef, useState } from "react";
import { Field, Select } from "@/components/ui/field";
import { useI18n } from "@/lib/i18n";
import type { HostUpdateInfo } from "@/lib/hosts/update-types";

type Settings = NonNullable<HostUpdateInfo["settings"]>;

export function HostUpdateChannel({ endpoint, settings, disabled, onPendingChange, onSaved }: {
  endpoint: string;
  settings: Settings;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onSaved: (settings: Settings) => void;
}) {
  const { t } = useI18n();
  const [channel, setChannel] = useState(settings.ompwebChannel);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { setChannel(settings.ompwebChannel); }, [settings.ompwebChannel]);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
    onPendingChange(false);
  }, [endpoint, onPendingChange]);
  const save = async () => {
    if (disabled || pending || channel === settings.ompwebChannel || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    setPending(true);
    onPendingChange(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ ompwebChannel: channel }) });
      const data = await response.json();
      if (request.current !== controller) return;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!(data.ompwebChannel === "stable" || data.ompwebChannel === "prerelease")) throw new Error(t("hostUpdates.invalidResponse"));
      onSaved({ ompwebChannel: data.ompwebChannel });
    } catch (cause) {
      if (request.current === controller) setError(t("hostUpdates.settingsSaveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      clearTimeout(timer);
      if (request.current === controller) {
        request.current = null;
        setPending(false);
        onPendingChange(false);
      }
    }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={pending} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    <Field label={t("hostUpdates.channel")}>
      <Select required disabled={disabled || pending} value={t(`hostUpdates.${channel}`)} options={[t("hostUpdates.stable"), t("hostUpdates.prerelease")]} onChange={(value) => setChannel(value === t("hostUpdates.prerelease") ? "prerelease" : "stable")} />
    </Field>
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <button type="submit" className="ui-focus-ring" disabled={disabled || pending || channel === settings.ompwebChannel} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", fontSize: 12 }}>{t(pending ? "hostUpdates.settingsSaving" : "hostUpdates.settingsSave")}</button>
      {error && <span role="alert" style={{ color: "var(--status-error)", fontSize: 12, overflowWrap: "anywhere" }}>{error}</span>}
    </div>
  </form>;
}

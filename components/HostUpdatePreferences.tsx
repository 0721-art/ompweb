"use client";

import { useEffect, useRef, useState } from "react";
import { Field, Select, TextInput } from "@/components/ui/field";
import type { HostUpdateInfo } from "@/lib/hosts/update-types";
import { useI18n } from "@/lib/i18n";

type Settings = NonNullable<HostUpdateInfo["settings"]>;

export function HostUpdatePreferences({ endpoint, settings, disabled, onPendingChange, onSaved }: {
  endpoint: string;
  settings: Settings;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onSaved: (settings: Settings) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(settings);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => { setDraft(settings); }, [settings]);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
    onPendingChange(false);
  }, [endpoint, onPendingChange]);

  const dirty = draft.ompSource !== settings.ompSource || draft.ompRepository !== settings.ompRepository || draft.ompwebChannel !== settings.ompwebChannel;
  const saveDisabled = disabled || pending || !dirty || (draft.ompSource === "custom" && !draft.ompRepository.trim());
  const save = async () => {
    if (saveDisabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    setPending(true);
    onPendingChange(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ ompSource: draft.ompSource, ompRepository: draft.ompRepository.trim(), ompwebChannel: draft.ompwebChannel }),
      });
      const data = await response.json();
      if (request.current !== controller) return;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!(data.ompSource === "upstream" || data.ompSource === "custom") || typeof data.ompRepository !== "string" || !(data.ompwebChannel === "stable" || data.ompwebChannel === "prerelease")) throw new Error(t("hostUpdates.invalidResponse"));
      onSaved(data as Settings);
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

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={pending} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Field label={t("hostUpdates.source")} style={{ flex: "1 1 160px" }}>
          <Select required disabled={disabled || pending} value={t(`hostUpdates.${draft.ompSource}`)} options={[t("hostUpdates.upstream"), t("hostUpdates.custom")]} onChange={(value) => setDraft((previous) => ({ ...previous, ompSource: value === t("hostUpdates.custom") ? "custom" : "upstream", ompRepository: value === t("hostUpdates.custom") ? previous.ompRepository : "" }))} />
        </Field>
        {draft.ompSource === "custom" && <Field label={t("hostUpdates.repository")} style={{ flex: "1 1 200px" }}>
          <TextInput value={draft.ompRepository} onChange={(ompRepository) => setDraft((previous) => ({ ...previous, ompRepository }))} placeholder="owner/repo" mono disabled={disabled || pending} autoComplete="off" spellCheck={false} />
        </Field>}
        <Field label={t("hostUpdates.channel")} style={{ flex: "1 1 160px" }}>
          <Select required disabled={disabled || pending} value={t(`hostUpdates.${draft.ompwebChannel}`)} options={[t("hostUpdates.stable"), t("hostUpdates.prerelease")]} onChange={(value) => setDraft((previous) => ({ ...previous, ompwebChannel: value === t("hostUpdates.prerelease") ? "prerelease" : "stable" }))} />
        </Field>
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <button type="submit" className="ui-focus-ring" disabled={saveDisabled} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", fontSize: 12, opacity: saveDisabled ? 0.6 : 1, cursor: saveDisabled ? "not-allowed" : "pointer" }}>{t(pending ? "hostUpdates.settingsSaving" : "hostUpdates.settingsSave")}</button>
        {pending && <span role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("hostUpdates.settingsSaving")}</span>}
        {error && <span role="alert" style={{ fontSize: 12, color: "var(--status-error)", overflowWrap: "anywhere" }}>{error}</span>}
      </div>
    </form>
  );
}

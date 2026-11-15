"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { GithubTokenStatus } from "@/lib/github-token";

type TokenResult = GithubTokenStatus & { limit?: number };

export function GithubTokenSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<TokenResult | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/github-token", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json() as TokenResult;
        if (alive) setStatus(data);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  const change = async (method: "PUT" | "POST" | "DELETE") => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/github-token", {
        method,
        ...(method === "PUT" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) } : {}),
      });
      const data = await response.json() as TokenResult;
      if (typeof data.set === "boolean") setStatus(data);
      if (!response.ok) throw new Error();
      if (method !== "POST") setToken("");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card" style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t("settingsConfig.githubToken")}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsConfig.githubTokenDesc")}</div>
      <input
        type="password"
        aria-label={t("settingsConfig.githubToken")}
        aria-describedby="github-token-status"
        autoComplete="new-password"
        spellCheck={false}
        maxLength={255}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        disabled={busy}
        style={{ width: "100%", boxSizing: "border-box", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
      />
      <div id="github-token-status" role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {status ? status.set ? t("settingsConfig.githubTokenSet", { last4: status.last4 ?? "" }) : t("settingsConfig.githubTokenNotSet") : !failed ? t("settingsConfig.githubTokenLoading") : null}
        {status?.rejected && <div style={{ color: "var(--status-error)" }}>{t("settingsConfig.githubTokenRejected")}</div>}
        {status?.limit !== undefined && <div>{t("settingsConfig.githubTokenLimit", { limit: status.limit })}</div>}
      </div>
      {failed && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{t("settingsConfig.githubTokenError")}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {(["PUT", "POST", "DELETE"] as const).map((method) => (
          <button
            key={method}
            type="button"
            onClick={() => void change(method)}
            disabled={busy || (method === "PUT" ? !/^[A-Za-z0-9_]{4,255}$/.test(token) : method === "DELETE" && !status?.set)}
            style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: busy ? "wait" : "pointer" }}
          >
            {t(method === "PUT" ? "settingsConfig.githubTokenSave" : method === "POST" ? "settingsConfig.githubTokenTest" : "settingsConfig.githubTokenRemove")}
          </button>
        ))}
      </div>
    </section>
  );
}

"use client";

import { Popover } from "@base-ui/react/popover";
import { Info } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Tooltip } from "./primitives";

export function SettingInfo({ label, children }: { label: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <span
        onMouseEnter={() => setTooltipOpen(true)}
        onMouseLeave={() => setTooltipOpen(false)}
        onFocus={() => setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
        style={{ display: "inline-flex", flex: "0 0 auto" }}
      >
        <Tooltip content={children} open={tooltipOpen} onOpenChange={setTooltipOpen}>
          <button
            ref={triggerRef}
            type="button"
            className="ui-focus-ring"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setTooltipOpen(false);
              setOpen((value) => !value);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 auto",
              width: "var(--control-height-sm)",
              height: "var(--control-height-sm)",
              padding: 0,
              border: 0,
              borderRadius: "var(--radius-control)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <Info size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </Tooltip>
      </span>
      <Popover.Portal>
        <Popover.Positioner anchor={triggerRef} side="top" align="start" sideOffset={6} collisionPadding={8} style={{ zIndex: 1100 }}>
          <Popover.Popup
            aria-label={label}
            finalFocus={triggerRef}
            className="ui-focus-ring"
            style={{
              width: 320,
              maxWidth: "calc((100vw - 16px) / var(--ui-scale, 1))",
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              boxShadow: "var(--shadow-pop)",
              fontSize: "var(--text-sm)",
              lineHeight: 1.5,
              outline: "none",
            }}
          >
            <Popover.Description style={{ margin: 0 }}>{children}</Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

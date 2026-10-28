import React from "react";

import { LogoutIcon, MonitorIcon } from "./Icons.jsx";

const CONNECTION_LABEL = {
  online: "Conectado",
  connecting: "Conectando…",
  offline: "Reconectando…"
};

export function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();
}

export function StatusDot({ connection }) {
  return (
    <span className="status">
      <span className={`dot ${connection}`} />
      {CONNECTION_LABEL[connection]}
    </span>
  );
}

export function TopBar({ user, connection, onLogout }) {
  return (
    <header className="topbar">
      <div className="brand small">
        <span className="brand-mark"><MonitorIcon size={16} /></span>
        <span className="brand-name">ScreenCast</span>
      </div>

      <div className="topbar-actions">
        <StatusDot connection={connection} />

        <div className="user-chip">
          <span className="avatar">{initials(user.name)}</span>
          <span className="user-name">{user.name}</span>
        </div>

        <button type="button" className="icon-btn" aria-label="Sair da conta" title="Sair da conta" onClick={onLogout}>
          <LogoutIcon />
        </button>
      </div>
    </header>
  );
}

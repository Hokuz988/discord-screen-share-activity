import React from "react";

const CONNECTION_LABEL = {
  online: "Conectado",
  connecting: "Conectando",
  offline: "Reconectando"
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

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-dot" aria-hidden="true" />
      ScreenCast
    </span>
  );
}

export function StatusDot({ connection }) {
  return (
    <span className={`status ${connection}`}>
      <span className="status-dot" aria-hidden="true" />
      {CONNECTION_LABEL[connection]}
    </span>
  );
}

const TABS = [
  { id: "rooms", label: "Salas" },
  { id: "audio", label: "Áudio sem Discord" }
];

export function TopBar({ user, connection, tab, onTab, onLogout }) {
  return (
    <header className="nav">
      <div className="nav-left">
        <Wordmark />

        <nav className="tabs" aria-label="Seções">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              className={`tab ${tab === item.id ? "active" : ""}`}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="nav-right">
        <StatusDot connection={connection} />
        <span className="nav-user" title={user.email}>{user.name}</span>
        <button type="button" className="btn btn-quiet" onClick={onLogout}>
          Sair
        </button>
      </div>
    </header>
  );
}

import React, { useState } from "react";

import { EnterIcon, LockIcon, PlusIcon } from "./Icons.jsx";
import { TopBar } from "./TopBar.jsx";

export function Lobby({ user, room, onLogout }) {
  const [invite, setInvite] = useState("");

  const offline = room.connection !== "online";
  const firstName = user.name.split(" ")[0];

  function join(event) {
    event.preventDefault();

    if (!room.busy) {
      room.joinRoom(invite);
    }
  }

  return (
    <div className="screen">
      <TopBar user={user} connection={room.connection} onLogout={onLogout} />

      <main className="lobby">
        <div className="lobby-inner">
          <div className="lobby-heading">
            <h1>Olá, {firstName}</h1>
            <p>Crie uma sala privada ou cole o convite que alguém te mandou.</p>
          </div>

          <div className="lobby-grid">
            <section className="card">
              <span className="card-icon accent"><PlusIcon size={22} /></span>
              <div className="card-text">
                <h2>Nova sala</h2>
                <p>
                  Geramos uma chave secreta no seu navegador. Só quem receber
                  o convite consegue entrar e assistir.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-lg push-down"
                disabled={offline || room.busy}
                onClick={room.createRoom}
              >
                {room.busy ? "Abrindo…" : "Criar sala"}
              </button>
            </section>

            <section className="card">
              <span className="card-icon success"><EnterIcon size={22} /></span>
              <div className="card-text">
                <h2>Entrar com convite</h2>
                <p>Cole o convite completo — ele traz o código da sala e a chave de criptografia.</p>
              </div>
              <form className="field push-down" onSubmit={join}>
                <label htmlFor="invite">Convite</label>
                <div className="inline-form">
                  <input
                    id="invite"
                    className="mono"
                    type="text"
                    value={invite}
                    onChange={event => setInvite(event.target.value)}
                    placeholder="K7Q2MXAB.f3a9…"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={120}
                  />
                  <button type="submit" className="btn btn-secondary btn-lg" disabled={offline || room.busy || !invite.trim()}>
                    Entrar
                  </button>
                </div>
              </form>
            </section>
          </div>

          {room.error && (
            <div className="alert" role="alert">
              {room.error}
              <button type="button" className="alert-close" aria-label="Fechar aviso" onClick={room.clearError}>×</button>
            </div>
          )}

          <div className="notice">
            <LockIcon size={20} />
            <p>
              A parte depois do ponto no convite é a chave da sala. Ela nunca é
              enviada ao servidor — compartilhe só com quem você confia.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

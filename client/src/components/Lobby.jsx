import React, { useState } from "react";

export function Lobby({ room }) {
  const [invite, setInvite] = useState("");

  const offline = room.connection !== "online";

  function join(event) {
    event.preventDefault();

    if (!room.busy) {
      room.joinRoom(invite);
    }
  }

  return (
    <main className="page narrow">
      <h1 className="page-title">Salas</h1>

      <section className="block">
        <div className="block-text">
          <h2>Criar sala</h2>
          <p className="muted">
            Gera um convite com a chave da sala. Só quem tiver o convite consegue entrar.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={offline || room.busy}
          onClick={room.createRoom}
        >
          {room.busy ? "Criando…" : "Criar sala"}
        </button>
      </section>

      <section className="block stacked">
        <div className="block-text">
          <h2>Entrar com convite</h2>
          <p className="muted">Cole o convite inteiro que te mandaram.</p>
        </div>

        <label htmlFor="invite" className="sr-only">Convite</label>
        <form className="inline-form" onSubmit={join}>
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
          <button type="submit" className="btn btn-secondary" disabled={offline || room.busy || !invite.trim()}>
            Entrar
          </button>
        </form>

        <p className="fine">
          O texto depois do ponto é a chave da sala. Ela não passa pelo servidor,
          então mande o convite só para quem você confia.
        </p>
      </section>

      {room.error && (
        <p className="form-error" role="alert">
          {room.error}
          <button type="button" className="link" onClick={room.clearError}>Fechar</button>
        </p>
      )}
    </main>
  );
}

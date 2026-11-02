import crypto from "node:crypto";
import { WebSocketServer } from "ws";

import { config } from "./config.js";
import { createRateLimiter, decrypt, safeEqual } from "./security.js";
import { resolveSession } from "./store.js";

/* =========================================================
   PROTOCOLO
   1. Cliente conecta e manda {type:"auth", token} em até 10s.
   2. Criar sala: {type:"create-room", keyCheck}
      Entrar:     {type:"join-room", roomId, keyCheck}
      keyCheck é um HMAC derivado da chave da sala (que só os
      clientes conhecem). O servidor compara, mas não consegue
      obter a chave a partir dele.
   3. Ofertas/respostas WebRTC chegam como {type:"signal",
      target, producerId, kind, payload}, onde payload é
      AES-GCM cifrado com a chave da sala. O servidor só
      repassa — não lê SDP, IPs nem fingerprints DTLS, e
      não consegue forjar uma oferta (MITM).
   4. "ready" traz uma chave de retomada. Se o socket cair, o
      cliente reautentica com {resume:{id, key}} e recupera a
      mesma vaga em até RESUME_GRACE_MS.
========================================================= */

const WS_OPEN = 1;

const AUTH_TIMEOUT_MS = 10_000;
const EMPTY_ROOM_TTL_MS = 60_000;
const RESUME_GRACE_MS = 30_000;
const MAX_SIGNAL_BYTES = 48 * 1024;

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 8;

const rooms = new Map();

/* id → conexão autenticada (aberta ou aguardando retomada). */
const identities = new Map();

const joinLimited = createRateLimiter({
  windowMs: 60_000,
  max: 15
});

/*
 * Limite por conexão: contador de janela fixa, sem timer. (Um
 * createRateLimiter por conexão deixava um setInterval vivo para
 * sempre a cada WebSocket aberto.)
 */
function createMessageBudget(max, windowMs) {
  let windowStart = Date.now();
  let count = 0;

  return function overBudget() {
    const now = Date.now();

    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }

    return ++count > max;
  };
}

/* =========================================================
   HELPERS
========================================================= */

function send(ws, message) {
  if (!ws || ws.readyState !== WS_OPEN) {
    return false;
  }

  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function broadcast(room, message, except = null) {
  for (const client of room.clients) {
    if (client !== except) {
      send(client, message);
    }
  }
}

function fail(ws, message) {
  send(ws, { type: "error", message });
}

function generateRoomCode() {
  let code;

  do {
    code = "";

    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    }
  } while (rooms.has(code));

  return code;
}

function isValidKeyCheck(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function producerList(room) {
  return Array.from(room.producers.values()).map(ws => ({
    id: ws.id,
    name: ws.user.name
  }));
}

function syncRoom(room) {
  broadcast(room, {
    type: "room-state",
    producers: producerList(room),
    viewers: room.clients.size - room.producers.size,
    participants: room.clients.size
  });
}

function findClient(room, id) {
  for (const client of room.clients) {
    if (client.id === id) {
      return client;
    }
  }

  return null;
}

/* =========================================================
   ROOM LIFECYCLE
========================================================= */

function stopProducing(ws) {
  const room = ws.room;

  if (!room || !room.producers.has(ws.id)) {
    return;
  }

  room.producers.delete(ws.id);

  broadcast(room, { type: "producer-left", producerId: ws.id }, ws);
  syncRoom(room);
}

function leaveRoom(ws) {
  const room = ws.room;

  if (!room) {
    return;
  }

  stopProducing(ws);

  room.clients.delete(ws);
  ws.room = null;

  broadcast(room, { type: "peer-left", peerId: ws.id });

  if (room.clients.size > 0) {
    syncRoom(room);
    return;
  }

  /*
   * Sala vazia sobrevive um pouco para quem caiu poder voltar.
   */
  room.expiryTimer = setTimeout(() => {
    if (room.clients.size === 0) {
      rooms.delete(room.id);
    }
  }, EMPTY_ROOM_TTL_MS);
}

function enterRoom(ws, room) {
  if (ws.room) {
    leaveRoom(ws);
  }

  clearTimeout(room.expiryTimer);

  room.clients.add(ws);
  ws.room = room;

  send(ws, { type: "room-joined", roomId: room.id });
  syncRoom(room);
}

/* =========================================================
   QUEDAS CURTAS
   O vídeo vai direto entre os navegadores; o servidor só
   apresenta um ao outro. Se o WebSocket cair (Wi-Fi, proxy),
   a vaga fica guardada um tempo: quem volta com a chave de
   retomada recupera o mesmo id, sala e transmissão, e as
   conexões WebRTC continuam de pé.
========================================================= */

function release(ws) {
  clearTimeout(ws.parkTimer);

  if (identities.get(ws.id) === ws) {
    identities.delete(ws.id);
  }

  leaveRoom(ws);
}

function resume(ws, data) {
  const old = identities.get(String(data?.id || ""));

  if (
    !old ||
    !old.room ||
    old.sessionHash !== ws.sessionHash ||
    !safeEqual(old.resumeKey, data.key)
  ) {
    return false;
  }

  const room = old.room;

  /* A conexão antiga pode estar meio aberta: derruba sem sair da sala. */
  clearTimeout(old.parkTimer);
  old.replaced = true;
  old.room = null;
  old.terminate();

  ws.id = old.id;
  ws.room = room;

  room.clients.delete(old);
  room.clients.add(ws);

  if (room.producers.get(ws.id) === old) {
    room.producers.set(ws.id, ws);
  }

  return true;
}

/* =========================================================
   HANDLERS
========================================================= */

const handlers = {

  ping(ws) {
    send(ws, { type: "pong" });
  },

  "create-room"(ws, msg) {
    if (!isValidKeyCheck(msg.keyCheck)) {
      return fail(ws, "Convite inválido.");
    }

    const room = {
      id: generateRoomCode(),
      keyCheck: msg.keyCheck,
      clients: new Set(),
      producers: new Map(),
      expiryTimer: null
    };

    rooms.set(room.id, room);
    enterRoom(ws, room);
  },

  "join-room"(ws, msg) {
    if (joinLimited(ws.ip)) {
      return fail(ws, "Muitas tentativas. Aguarde um minuto.");
    }

    const roomId = String(msg.roomId || "").trim().toUpperCase();
    const room = rooms.get(roomId);

    /*
     * Mesma mensagem para sala inexistente e chave errada:
     * não revela quais códigos existem.
     */
    if (
      !room ||
      !isValidKeyCheck(msg.keyCheck) ||
      !safeEqual(room.keyCheck, msg.keyCheck)
    ) {
      return fail(ws, "Convite inválido ou sala encerrada.");
    }

    enterRoom(ws, room);
  },

  "leave-room"(ws) {
    leaveRoom(ws);
    send(ws, { type: "room-left" });
  },

  "start-sharing"(ws) {
    const room = ws.room;

    if (!room) {
      return fail(ws, "Você não está em uma sala.");
    }

    if (room.producers.has(ws.id)) {
      return;
    }

    if (room.producers.size >= config.maxProducers) {
      return fail(
        ws,
        `A sala já tem ${config.maxProducers} transmissões ativas.`
      );
    }

    room.producers.set(ws.id, ws);

    send(ws, { type: "sharing-started" });
    broadcast(room, { type: "producer", producerId: ws.id, name: ws.user.name }, ws);
    syncRoom(room);
  },

  "stop-sharing"(ws) {
    stopProducing(ws);
  },

  "request-offer"(ws, msg) {
    const room = ws.room;

    if (!room) {
      return;
    }

    const producer = room.producers.get(String(msg.producerId || ""));

    if (!producer || producer === ws) {
      return;
    }

    send(producer, { type: "request-offer", viewerId: ws.id });
  },

  signal(ws, msg) {
    const room = ws.room;

    if (!room) {
      return;
    }

    const target = findClient(room, String(msg.target || ""));
    const kind = msg.kind;
    const producerId = String(msg.producerId || "");

    if (!target || target === ws) {
      return;
    }

    if (
      typeof msg.payload !== "string" ||
      msg.payload.length > MAX_SIGNAL_BYTES
    ) {
      return;
    }

    /*
     * Oferta: só um producer, falando por si mesmo.
     * Resposta: só para um producer, sobre ele mesmo.
     */
    if (kind === "offer") {
      if (producerId !== ws.id || !room.producers.has(ws.id)) {
        return;
      }
    } else if (kind === "answer") {
      if (producerId !== target.id || !room.producers.has(target.id)) {
        return;
      }
    } else {
      return;
    }

    send(target, {
      type: "signal",
      kind,
      from: ws.id,
      producerId,
      payload: msg.payload
    });
  }
};

/* =========================================================
   SERVER
========================================================= */

export function attachSignaling(server) {
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,

    verifyClient({ origin }, done) {
      if (
        config.allowedOrigins.length === 0 ||
        config.allowedOrigins.includes(origin)
      ) {
        return done(true);
      }

      done(false, 403, "Origem não permitida");
    }
  });

  wss.on("connection", (ws, req) => {
    ws.id = crypto.randomUUID();
    ws.ip = config.trustProxy
      ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress
      : req.socket.remoteAddress;
    ws.user = null;
    ws.sessionHash = null;
    ws.room = null;
    ws.isAlive = true;

    const overBudget = createMessageBudget(120, 10_000);

    const authTimer = setTimeout(() => {
      if (!ws.user) {
        ws.close(4001, "auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", raw => {
      ws.isAlive = true;

      if (overBudget()) {
        return ws.close(4029, "rate limit");
      }

      let msg;

      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg || typeof msg.type !== "string") {
        return;
      }

      if (!ws.user) {
        if (msg.type !== "auth") {
          return ws.close(4001, "unauthenticated");
        }

        const session = resolveSession(msg.token);

        if (!session) {
          return ws.close(4001, "invalid session");
        }

        clearTimeout(authTimer);

        ws.sessionHash = session.hash;
        ws.resumeKey = crypto.randomBytes(24).toString("base64url");
        ws.user = {
          id: session.user.id,
          name: decrypt(session.user.nameEnc, `name:${session.user.id}`)
        };

        const resumed = resume(ws, msg.resume);

        identities.set(ws.id, ws);

        send(ws, {
          type: "ready",
          id: ws.id,
          resume: ws.resumeKey,
          resumed,
          producing: resumed && ws.room.producers.has(ws.id)
        });

        if (resumed) {
          syncRoom(ws.room);
        }

        return;
      }

      const handler = Object.hasOwn(handlers, msg.type)
        ? handlers[msg.type]
        : null;

      if (handler) {
        handler(ws, msg);
      }
    });

    ws.on("close", code => {
      clearTimeout(authTimer);

      if (ws.replaced) {
        return;
      }

      /* 1000/1001: saiu de propósito (fechou a aba ou a atividade). */
      if (ws.room && !ws.noResume && code !== 1000 && code !== 1001) {
        ws.parkTimer = setTimeout(() => release(ws), RESUME_GRACE_MS);
        return;
      }

      release(ws);
    });

    ws.on("error", () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;

      try {
        ws.ping();
      } catch {}
    }
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  return {
    /*
     * Derruba sockets cujas sessões foram encerradas (logout,
     * vínculo com Google etc.).
     */
    closeSessions(hashes) {
      const revoked = new Set(hashes);

      for (const ws of identities.values()) {
        if (!revoked.has(ws.sessionHash)) {
          continue;
        }

        ws.noResume = true;

        if (ws.readyState === WS_OPEN) {
          ws.close(4001, "session revoked");
        } else {
          release(ws);
        }
      }
    },

    stats() {
      return { rooms: rooms.size, clients: wss.clients.size };
    }
  };
}

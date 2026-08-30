import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

const PORT = process.env.PORT || 8787;

/* ==========================================
   UTILIDADES
========================================== */

function generateRoomCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 6; i++) {
    code += characters[
      Math.floor(Math.random() * characters.length)
    ];
  }

  return code;
}

function createRoomCode() {
  let code;

  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  return code;
}

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, except = null) {
  for (const client of room.clients) {
    if (
      client !== except &&
      client.readyState === 1
    ) {
      send(client, message);
    }
  }
}

function viewerCount(room) {
  return Math.max(
    0,
    room.clients.size -
      (room.producer ? 1 : 0)
  );
}

function updateViewerCount(room) {
  broadcast(room, {
    type: "viewer-count",
    count: viewerCount(room),
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

/* ==========================================
   HTTP
========================================== */

app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "ScreenCast Signaling Server",
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "screencast-signaling",
    rooms: rooms.size,
  });
});

/* ==========================================
   SAIR DA SALA
========================================== */

function leaveRoom(ws) {
  const room = ws.room;

  if (!room) {
    return;
  }

  /*
   * Se era o transmissor,
   * avisa os espectadores.
   */

  if (room.producer === ws) {
    room.producer = null;
    ws.isProducer = false;

    broadcast(
      room,
      {
        type: "producer-left",
      },
      ws
    );
  }

  room.clients.delete(ws);

  ws.room = null;
  ws.isProducer = false;

  updateViewerCount(room);

  /*
   * Remove sala vazia.
   */

  if (room.clients.size === 0) {
    rooms.delete(room.id);

    console.log(
      `[ROOM] Sala removida: ${room.id}`
    );
  }
}

/* ==========================================
   WEBSOCKET
========================================== */

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.room = null;
  ws.isProducer = false;

  console.log(
    `[CONNECT] ${ws.id}`
  );

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.warn(
        "[ERROR] Mensagem JSON inválida"
      );

      return;
    }

    console.log(
      `[MESSAGE] ${ws.id} -> ${msg.type}`
    );

    /* ======================================
       CRIAR SALA
    ====================================== */

    if (msg.type === "create-room") {
      if (ws.room) {
        leaveRoom(ws);
      }

      const roomId = createRoomCode();

      const room = {
        id: roomId,
        clients: new Set(),
        producer: null,
      };

      rooms.set(roomId, room);

      room.clients.add(ws);

      ws.room = room;

      send(ws, {
        type: "room-created",
        roomId,
      });

      send(ws, {
        type: "viewer-count",
        count: 0,
      });

      console.log(
        `[ROOM] Criada: ${roomId}`
      );

      return;
    }

    /* ======================================
       ENTRAR EM SALA
    ====================================== */

    if (msg.type === "join-room") {
      const roomId = String(
        msg.roomId || ""
      )
        .trim()
        .toUpperCase();

      if (!roomId) {
        send(ws, {
          type: "error",
          message: "Digite o código da sala.",
        });

        return;
      }

      const room = rooms.get(roomId);

      if (!room) {
        send(ws, {
          type: "error",
          message: "Sala não encontrada.",
        });

        return;
      }

      if (ws.room) {
        leaveRoom(ws);
      }

      room.clients.add(ws);

      ws.room = room;

      send(ws, {
        type: "room-joined",
        roomId,
      });

      /*
       * Se já existe transmissão,
       * avisa o novo usuário.
       */

      if (
        room.producer &&
        room.producer !== ws
      ) {
        send(ws, {
          type: "producer",
          producerId: room.producer.id,
        });
      }

      send(ws, {
        type: "viewer-count",
        count: viewerCount(room),
      });

      updateViewerCount(room);

      console.log(
        `[ROOM] ${ws.id} entrou em ${roomId}`
      );

      return;
    }

    /* ======================================
       SAIR
    ====================================== */

    if (msg.type === "leave-room") {
      leaveRoom(ws);

      return;
    }

    /* ======================================
       COMEÇAR TRANSMISSÃO
    ====================================== */

    if (msg.type === "start-sharing") {
      const room = ws.room;

      if (!room) {
        send(ws, {
          type: "error",
          message:
            "Você não está em uma sala.",
        });

        return;
      }

      /*
       * Apenas uma pessoa pode transmitir.
       */

      if (
        room.producer &&
        room.producer !== ws
      ) {
        send(ws, {
          type: "error",
          message:
            "Já existe alguém transmitindo nesta sala.",
        });

        return;
      }

      room.producer = ws;
      ws.isProducer = true;

      console.log(
        `[PRODUCER] ${ws.id} começou a transmitir em ${room.id}`
      );

      broadcast(
        room,
        {
          type: "producer",
          producerId: ws.id,
        },
        ws
      );

      updateViewerCount(room);

      return;
    }

    /* ======================================
       PARAR TRANSMISSÃO
    ====================================== */

    if (msg.type === "stop-sharing") {
      const room = ws.room;

      if (
        room &&
        room.producer === ws
      ) {
        room.producer = null;
        ws.isProducer = false;

        console.log(
          `[PRODUCER] ${ws.id} parou de transmitir`
        );

        broadcast(
          room,
          {
            type: "producer-left",
          },
          ws
        );

        updateViewerCount(room);
      }

      return;
    }

    /* ======================================
       PEDIR OFFER
    ====================================== */

    if (msg.type === "request-offer") {
      const room = ws.room;

      if (
        !room ||
        !room.producer
      ) {
        return;
      }

      const producer = room.producer;

      if (
        producer.readyState !== 1
      ) {
        return;
      }

      console.log(
        `[OFFER REQUEST] ${ws.id} -> ${producer.id}`
      );

      send(producer, {
        type: "request-offer",
        viewerId: ws.id,
      });

      return;
    }

    /* ======================================
       OFFER
    ====================================== */

    if (msg.type === "offer") {
      const room = ws.room;

      if (!room) {
        return;
      }

      const target = findClient(
        room,
        msg.target
      );

      if (!target) {
        console.warn(
          `[OFFER] Cliente ${msg.target} não encontrado`
        );

        return;
      }

      send(target, {
        type: "offer",
        from: ws.id,
        offer: msg.offer,
      });

      console.log(
        `[OFFER] ${ws.id} -> ${target.id}`
      );

      return;
    }

    /* ======================================
       ANSWER
    ====================================== */

    if (msg.type === "answer") {
      const room = ws.room;

      if (!room) {
        return;
      }

      const target = findClient(
        room,
        msg.target
      );

      if (!target) {
        console.warn(
          `[ANSWER] Cliente ${msg.target} não encontrado`
        );

        return;
      }

      send(target, {
        type: "answer",
        from: ws.id,
        answer: msg.answer,
      });

      console.log(
        `[ANSWER] ${ws.id} -> ${target.id}`
      );

      return;
    }

    /* ======================================
       ICE
    ====================================== */

    if (msg.type === "ice") {
      const room = ws.room;

      if (!room) {
        return;
      }

      const target = findClient(
        room,
        msg.target
      );

      if (!target) {
        return;
      }

      send(target, {
        type: "ice",
        from: ws.id,
        candidate: msg.candidate,
      });

      return;
    }
  });

  /* ========================================
     FECHOU CONEXÃO
  ======================================== */

  ws.on("close", () => {
    console.log(
      `[DISCONNECT] ${ws.id}`
    );

    leaveRoom(ws);
  });

  ws.on("error", (error) => {
    console.error(
      `[WS ERROR] ${ws.id}`,
      error
    );
  });
});

/* ==========================================
   SERVIDOR
========================================== */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `ScreenCast server rodando na porta ${PORT}`
    );
  }
);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `A porta ${PORT} já está sendo usada.`
    );

    console.error(
      `Feche o outro servidor ou altere a porta.`
    );
  } else {
    console.error(
      "Erro no servidor:",
      error
    );
  }
});

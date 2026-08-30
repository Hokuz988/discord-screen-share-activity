import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";

const app = express();

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
});

const rooms = new Map();

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "screencast-signaling",
  });
});

function broadcast(room, message, except = null) {
  for (const client of room.clients) {
    if (
      client !== except &&
      client.readyState === 1
    ) {
      client.send(JSON.stringify(message));
    }
  }
}

wss.on("connection", (ws) => {
  ws.room = null;
  ws.isProducer = false;
  ws.id = crypto.randomUUID();

  console.log("Cliente conectado:", ws.id);

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.warn("Mensagem inválida recebida.");
      return;
    }

    console.log("Mensagem:", ws.id, msg.type);

    /*
     * JOIN
     */
    if (msg.type === "join") {
      const roomId =
        msg.roomId || "default";

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          clients: new Set(),
          producer: null,
        });
      }

      const room = rooms.get(roomId);

      room.clients.add(ws);

      ws.room = room;

      /*
       * Envia quantidade de espectadores.
       */
      ws.send(
        JSON.stringify({
          type: "viewer-count",
          count: Math.max(
            0,
            room.clients.size -
              (room.producer ? 1 : 0)
          ),
        })
      );

      /*
       * Se já existe alguém transmitindo,
       * avisa o novo usuário.
       */
      if (
        room.producer &&
        room.producer !== ws
      ) {
        ws.send(
          JSON.stringify({
            type: "producer",
            producerId:
              room.producer.id,
          })
        );
      }

      /*
       * Atualiza todos.
       */
      broadcast(room, {
        type: "viewer-count",
        count: Math.max(
          0,
          room.clients.size -
            (room.producer ? 1 : 0)
        ),
      });

      return;
    }

    const room = ws.room;

    if (!room) {
      return;
    }

    /*
     * COMEÇAR TRANSMISSÃO
     */
    if (msg.type === "start-sharing") {
      console.log(
        "Novo produtor:",
        ws.id
      );

      /*
       * Se já existia outro produtor,
       * tira o status dele.
       */
      if (
        room.producer &&
        room.producer !== ws
      ) {
        room.producer.isProducer = false;
      }

      room.producer = ws;

      ws.isProducer = true;

      broadcast(
        room,
        {
          type: "producer",
          producerId: ws.id,
        },
        ws
      );

      broadcast(room, {
        type: "viewer-count",
        count: Math.max(
          0,
          room.clients.size - 1
        ),
      });

      return;
    }

    /*
     * PARAR TRANSMISSÃO
     */
    if (msg.type === "stop-sharing") {
      if (room.producer === ws) {
        console.log(
          "Produtor parou:",
          ws.id
        );

        room.producer = null;

        ws.isProducer = false;

        broadcast(
          room,
          {
            type: "producer-left",
          },
          ws
        );

        broadcast(room, {
          type: "viewer-count",
          count: room.clients.size,
        });
      }

      return;
    }

    /*
     * ESPECTADOR PEDE OFFER
     */
    if (msg.type === "request-offer") {
      if (
        room.producer &&
        room.producer.readyState === 1
      ) {
        console.log(
          "Solicitando Offer ao produtor:",
          room.producer.id
        );

        room.producer.send(
          JSON.stringify({
            type: "request-offer",
            viewerId: ws.id,
          })
        );
      }

      return;
    }

    /*
     * OFFER
     */
    if (msg.type === "offer") {
      const target = [
        ...room.clients,
      ].find(
        (client) =>
          client.id === msg.target
      );

      if (target) {
        console.log(
          "Enviando Offer:",
          ws.id,
          "->",
          target.id
        );

        target.send(
          JSON.stringify({
            type: "offer",
            from: ws.id,
            offer: msg.offer,
          })
        );
      }

      return;
    }

    /*
     * ANSWER
     */
    if (msg.type === "answer") {
      const target = [
        ...room.clients,
      ].find(
        (client) =>
          client.id === msg.target
      );

      if (target) {
        console.log(
          "Enviando Answer:",
          ws.id,
          "->",
          target.id
        );

        target.send(
          JSON.stringify({
            type: "answer",
            from: ws.id,
            answer: msg.answer,
          })
        );
      }

      return;
    }

    /*
     * ICE
     */
    if (msg.type === "ice") {
      const target = [
        ...room.clients,
      ].find(
        (client) =>
          client.id === msg.target
      );

      if (target) {
        target.send(
          JSON.stringify({
            type: "ice",
            from: ws.id,
            candidate: msg.candidate,
          })
        );
      }

      return;
    }
  });

  /*
   * CLIENTE DESCONECTOU
   */
  ws.on("close", () => {
    console.log(
      "Cliente desconectado:",
      ws.id
    );

    const room = ws.room;

    if (!room) {
      return;
    }

    /*
     * Se era o produtor,
     * avisa os espectadores.
     */
    if (room.producer === ws) {
      room.producer = null;

      broadcast(
        room,
        {
          type: "producer-left",
        },
        ws
      );
    }

    room.clients.delete(ws);

    /*
     * Atualiza quantidade.
     */
    if (room.clients.size > 0) {
      broadcast(room, {
        type: "viewer-count",
        count: Math.max(
          0,
          room.clients.size -
            (room.producer ? 1 : 0)
        ),
      });
    }

    /*
     * Remove sala vazia.
     */
    if (room.clients.size === 0) {
      for (const [
        key,
        value,
      ] of rooms) {
        if (value === room) {
          rooms.delete(key);
        }
      }
    }
  });

  ws.on("error", (error) => {
    console.error(
      "WebSocket error:",
      error
    );
  });
});

const PORT =
  process.env.PORT || 8787;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Signaling server running on :${PORT}`
    );
  }
);
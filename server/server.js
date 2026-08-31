import http from "node:http";
import crypto from "node:crypto";

import express from "express";
import cors from "cors";

import {
  WebSocketServer
} from "ws";

/* =========================================================
   APP
========================================================= */

const app = express();

const server = http.createServer(app);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"]
  })
);

app.use(express.json());

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false
});

const rooms = new Map();

const PORT =
  Number(process.env.PORT) || 8787;

const MAX_PRODUCERS = 3;

const WS_OPEN = 1;

/* =========================================================
   HTTP
========================================================= */

app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "ScreenCast Signaling Server",
    maxProducers: MAX_PRODUCERS,
    rooms: rooms.size
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "screencast-signaling",
    rooms: rooms.size,
    maxProducers: MAX_PRODUCERS
  });
});

/* =========================================================
   TURN
========================================================= */

app.get(
  "/turn-credentials",
  async (_, res) => {
    try {
      const keyId =
        process.env.TURN_KEY_ID;

      const apiToken =
        process.env.TURN_API_TOKEN;

      if (!keyId || !apiToken) {
        return res.status(500).json({
          error:
            "TURN não configurado no servidor"
        });
      }

      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${apiToken}`,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            ttl: 3600
          })
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          "[TURN] Cloudflare:",
          data
        );

        return res.status(500).json({
          error:
            "Não foi possível gerar credenciais TURN"
        });
      }

      return res.json(data);

    } catch (error) {
      console.error(
        "[TURN]",
        error
      );

      return res.status(500).json({
        error:
          "Erro interno ao gerar TURN"
      });
    }
  }
);

/* =========================================================
   SEND
========================================================= */

function send(ws, message) {
  if (!ws) {
    return false;
  }

  if (ws.readyState !== WS_OPEN) {
    return false;
  }

  try {
    ws.send(
      JSON.stringify(message)
    );

    return true;

  } catch (error) {
    console.error(
      "[SEND]",
      error
    );

    return false;
  }
}

/* =========================================================
   BROADCAST
========================================================= */

function broadcast(
  room,
  message,
  except = null
) {
  if (!room) {
    return;
  }

  for (const client of room.clients) {
    if (client === except) {
      continue;
    }

    if (
      client.readyState !== WS_OPEN
    ) {
      continue;
    }

    send(
      client,
      message
    );
  }
}

/* =========================================================
   PRODUCERS
========================================================= */

function getProducerList(room) {
  if (!room) {
    return [];
  }

  return Array.from(
    room.producers.values()
  ).map(producer => ({
    id: producer.id,

    producerId: producer.id,

    name:
      producer.displayName ||
      producer.userName ||
      "Sem nome",

    displayName:
      producer.displayName ||
      producer.userName ||
      "Sem nome",

    producerName:
      producer.displayName ||
      producer.userName ||
      "Sem nome"
  }));
}

function updateProducerList(room) {
  if (!room) {
    return;
  }

  const producers =
    getProducerList(room);

  console.log(
    `[PRODUCERS] ${room.id}:`,
    producers
  );

  broadcast(
    room,
    {
      type:
        "producer-list",

      producers
    }
  );
}

/* =========================================================
   VIEWERS
========================================================= */

function getViewerCount(room) {
  if (!room) {
    return 0;
  }

  let viewers = 0;

  for (const client of room.clients) {
    if (!client.isProducer) {
      viewers++;
    }
  }

  return viewers;
}

function updateViewerCount(room) {
  if (!room) {
    return;
  }

  broadcast(
    room,
    {
      type:
        "viewer-count",

      count:
        getViewerCount(room)
    }
  );
}

/* =========================================================
   FIND CLIENT
========================================================= */

function findClient(
  room,
  id
) {
  if (!room || !id) {
    return null;
  }

  for (const client of room.clients) {
    if (client.id === id) {
      return client;
    }
  }

  return null;
}

/* =========================================================
   ROOM CODE
========================================================= */

function generateRoomCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 6; i++) {
    code +=
      chars[
        Math.floor(
          Math.random() *
          chars.length
        )
      ];
  }

  return code;
}

function createRoomCode() {
  let code;

  do {
    code =
      generateRoomCode();
  } while (rooms.has(code));

  return code;
}

/* =========================================================
   REMOVE PRODUCER
========================================================= */

function removeProducer(ws) {
  const room = ws.room;

  if (!room) {
    return;
  }

  if (
    !room.producers.has(ws.id)
  ) {
    return;
  }

  console.log(
    `[PRODUCER] REMOVENDO ${ws.id} DA SALA ${room.id}`
  );

  room.producers.delete(
    ws.id
  );

  ws.isProducer = false;

  broadcast(
    room,
    {
      type:
        "producer-left",

      producerId:
        ws.id
    },
    ws
  );

  updateProducerList(room);
  updateViewerCount(room);
}

/* =========================================================
   LEAVE ROOM
========================================================= */

function leaveRoom(ws) {
  const room = ws.room;

  if (!room) {
    return;
  }

  console.log(
    `[ROOM] ${ws.id} saindo de ${room.id}`
  );

  if (
    room.producers.has(ws.id)
  ) {
    removeProducer(ws);
  }

  room.clients.delete(ws);

  ws.room = null;
  ws.isProducer = false;

  if (room.clients.size > 0) {
    updateProducerList(room);
    updateViewerCount(room);
  } else {
    rooms.delete(room.id);

    console.log(
      `[ROOM] ${room.id} removida`
    );
  }
}

/* =========================================================
   SAME ROOM
========================================================= */

function sameRoom(
  sender,
  target
) {
  if (!sender || !target) {
    return false;
  }

  return (
    sender.room &&
    target.room &&
    sender.room === target.room
  );
}

/* =========================================================
   WEBSOCKET
========================================================= */

wss.on(
  "connection",
  ws => {

    ws.id =
      crypto.randomUUID();

    ws.room = null;

    ws.isProducer =
      false;

    ws.userName =
      "";

    ws.displayName =
      "";

    ws.isAlive =
      true;

    console.log(
      `[CONNECT] ${ws.id}`
    );

    send(
      ws,
      {
        type:
          "client-id",

        id:
          ws.id
      }
    );

    /* =====================================================
       PING / PONG
    ===================================================== */

    ws.on(
      "pong",
      () => {
        ws.isAlive = true;
      }
    );

    /* =====================================================
       MESSAGE
    ===================================================== */

    ws.on(
      "message",
      raw => {

        let msg;

        try {
          msg =
            JSON.parse(
              raw.toString()
            );

        } catch {
          console.warn(
            `[MESSAGE] JSON inválido de ${ws.id}`
          );

          return;
        }

        if (
          !msg ||
          typeof msg.type !==
            "string"
        ) {
          return;
        }

        console.log(
          `[MESSAGE] ${ws.id}: ${msg.type}`
        );

        /* =================================================
           CREATE ROOM
        ================================================= */

        if (
          msg.type ===
          "create-room"
        ) {

          if (ws.room) {
            leaveRoom(ws);
          }

          const roomId =
            createRoomCode();

          const room = {
            id:
              roomId,

            clients:
              new Set(),

            producers:
              new Map()
          };

          rooms.set(
            roomId,
            room
          );

          room.clients.add(
            ws
          );

          ws.room =
            room;

          ws.isProducer =
            false;

          ws.userName =
            String(
              msg.userName ||
              msg.displayName ||
              ""
            )
              .trim()
              .slice(0, 40);

          ws.displayName =
            ws.userName;

          send(
            ws,
            {
              type:
                "room-created",

              roomId
            }
          );

          send(
            ws,
            {
              type:
                "producer-list",

              producers:
                []
            }
          );

          send(
            ws,
            {
              type:
                "viewer-count",

              count:
                0
            }
          );

          console.log(
            `[ROOM] criada: ${roomId} por ${ws.id} (${ws.userName || "Sem nome"})`
          );

          return;
        }

        /* =================================================
           JOIN ROOM
        ================================================= */

        if (
          msg.type ===
          "join-room"
        ) {

          const roomId =
            String(
              msg.roomId ||
              ""
            )
              .trim()
              .toUpperCase();

          if (!roomId) {
            send(
              ws,
              {
                type:
                  "error",

                message:
                  "Digite o código da sala."
              }
            );

            return;
          }

          const room =
            rooms.get(
              roomId
            );

          if (!room) {
            send(
              ws,
              {
                type:
                  "error",

                message:
                  "Sala não encontrada."
              }
            );

            return;
          }

          if (ws.room) {
            leaveRoom(ws);
          }

          room.clients.add(
            ws
          );

          ws.room =
            room;

          ws.isProducer =
            false;

          ws.userName =
            String(
              msg.userName ||
              msg.displayName ||
              ""
            )
              .trim()
              .slice(0, 40);

          ws.displayName =
            ws.userName;

          send(
            ws,
            {
              type:
                "room-joined",

              roomId
            }
          );

          send(
            ws,
            {
              type:
                "producer-list",

              producers:
                getProducerList(
                  room
                )
            }
          );

          send(
            ws,
            {
              type:
                "viewer-count",

              count:
                getViewerCount(
                  room
                )
            }
          );

          broadcast(
            room,
            {
              type:
                "producer-list",

              producers:
                getProducerList(
                  room
                )
            },
            ws
          );

          updateViewerCount(
            room
          );

          console.log(
            `[ROOM] ${ws.id} entrou em ${roomId} como "${ws.userName || "Sem nome"}"`
          );

          return;
        }

        /* =================================================
           LEAVE ROOM
        ================================================= */

        if (
          msg.type ===
          "leave-room"
        ) {

          leaveRoom(ws);

          send(
            ws,
            {
              type:
                "left-room"
            }
          );

          return;
        }

        /* =================================================
           START SHARING
        ================================================= */

        if (
          msg.type ===
          "start-sharing"
        ) {

          const room =
            ws.room;

          if (!room) {
            send(
              ws,
              {
                type:
                  "error",

                message:
                  "Você não está em uma sala."
              }
            );

            return;
          }

          /*
           * PROTEÇÃO PRINCIPAL CONTRA DUPLICAÇÃO.
           *
           * Cada conexão só pode possuir
           * UMA transmissão.
           */

          if (
            room.producers.has(
              ws.id
            ) ||
            ws.isProducer
          ) {

            console.warn(
              `[PRODUCER] ${ws.id} tentou iniciar uma segunda transmissão. Ignorado.`
            );

            send(
              ws,
              {
                type:
                  "sharing-already-active",

                producerId:
                  ws.id
              }
            );

            return;
          }

          if (
            room.producers.size >=
            MAX_PRODUCERS
          ) {

            send(
              ws,
              {
                type:
                  "error",

                message:
                  `A sala já possui ${MAX_PRODUCERS} transmissões ativas.`
              }
            );

            return;
          }

          /*
           * ACEITA QUALQUER UMA DAS FORMAS,
           * MAS NORMALIZA INTERNAMENTE.
           */

          const displayName =
            String(
              msg.displayName ||
              msg.producerName ||
              msg.userName ||
              ws.userName ||
              ""
            )
              .trim()
              .slice(0, 40);

          ws.userName =
            displayName ||
            ws.userName ||
            "Usuário";

          ws.displayName =
            displayName ||
            ws.userName ||
            "Usuário";

          /*
           * Só AGORA transforma a conexão
           * em producer.
           */

          room.producers.set(
            ws.id,
            ws
          );

          ws.isProducer =
            true;

          console.log(
            `[PRODUCER] ${ws.id} COMEÇOU A TRANSMITIR COMO "${ws.displayName}"`
          );

          /*
           * Um único evento de producer.
           */

          broadcast(
            room,
            {
              type:
                "producer",

              producerId:
                ws.id,

              displayName:
                ws.displayName,

              producerName:
                ws.displayName,

              name:
                ws.displayName
            },
            ws
          );

          /*
           * Atualiza lista completa.
           */

          updateProducerList(
            room
          );

          updateViewerCount(
            room
          );

          return;
        }

        /* =================================================
           STOP SHARING
        ================================================= */

        if (
          msg.type ===
          "stop-sharing"
        ) {

          console.log(
            `[PRODUCER] ${ws.id} enviou STOP`
          );

          removeProducer(
            ws
          );

          return;
        }

        /* =================================================
           REQUEST OFFER
        ================================================= */

        if (
          msg.type ===
          "request-offer"
        ) {

          const room =
            ws.room;

          if (!room) {
            return;
          }

          const producerId =
            String(
              msg.producerId ||
              ""
            );

          if (!producerId) {
            return;
          }

          const producer =
            room.producers.get(
              producerId
            );

          if (!producer) {
            send(
              ws,
              {
                type:
                  "error",

                message:
                  "Essa transmissão não está mais ativa."
              }
            );

            return;
          }

          if (
            producer.id ===
            ws.id
          ) {
            return;
          }

          if (
            !sameRoom(
              ws,
              producer
            )
          ) {
            return;
          }

          send(
            producer,
            {
              type:
                "request-offer",

              viewerId:
                ws.id
            }
          );

          return;
        }

        /* =================================================
           OFFER
        ================================================= */

        if (
          msg.type ===
          "offer"
        ) {

          const room =
            ws.room;

          if (!room) {
            return;
          }

          const targetId =
            String(
              msg.target ||
              ""
            );

          if (!targetId) {
            return;
          }

          const target =
            findClient(
              room,
              targetId
            );

          if (!target) {
            return;
          }

          if (
            !room.producers.has(
              ws.id
            )
          ) {
            return;
          }

          if (
            !sameRoom(
              ws,
              target
            )
          ) {
            return;
          }

          send(
            target,
            {
              type:
                "offer",

              from:
                ws.id,

              producerId:
                ws.id,

              producerName:
                ws.displayName ||
                ws.userName ||
                "Usuário",

              offer:
                msg.offer
            }
          );

          return;
        }

        /* =================================================
           ANSWER
        ================================================= */

        if (
          msg.type ===
          "answer"
        ) {

          const room =
            ws.room;

          if (!room) {
            return;
          }

          const targetId =
            String(
              msg.target ||
              ""
            );

          if (!targetId) {
            return;
          }

          const target =
            findClient(
              room,
              targetId
            );

          if (!target) {
            return;
          }

          if (
            !room.producers.has(
              target.id
            )
          ) {
            return;
          }

          if (
            !sameRoom(
              ws,
              target
            )
          ) {
            return;
          }

          send(
            target,
            {
              type:
                "answer",

              from:
                ws.id,

              producerId:
                msg.producerId,

              answer:
                msg.answer
            }
          );

          return;
        }

        /* =================================================
           ICE
        ================================================= */

        if (
          msg.type ===
          "ice"
        ) {

          const room =
            ws.room;

          if (!room) {
            return;
          }

          const targetId =
            String(
              msg.target ||
              ""
            );

          if (!targetId) {
            return;
          }

          const target =
            findClient(
              room,
              targetId
            );

          if (!target) {
            return;
          }

          if (
            !sameRoom(
              ws,
              target
            )
          ) {
            return;
          }

          const producerId =
            String(
              msg.producerId ||
              ""
            );

          if (!producerId) {
            return;
          }

          if (
            !room.producers.has(
              producerId
            )
          ) {
            return;
          }

          send(
            target,
            {
              type:
                "ice",

              from:
                ws.id,

              producerId,

              candidate:
                msg.candidate
            }
          );

          return;
        }

        /* =================================================
           UNKNOWN
        ================================================= */

        console.warn(
          `[MESSAGE] tipo desconhecido: ${msg.type}`
        );
      }
    );

    /* =====================================================
       CLOSE
    ===================================================== */

    ws.on(
      "close",
      (code, reason) => {

        console.log(
          `[DISCONNECT] ${ws.id}`,
          {
            code,
            reason:
              reason?.toString() ||
              ""
          }
        );

        leaveRoom(
          ws
        );
      }
    );

    /* =====================================================
       ERROR
    ===================================================== */

    ws.on(
      "error",
      error => {

        console.error(
          `[WS ERROR] ${ws.id}`,
          error
        );
      }
    );
  }
);

/* =========================================================
   HEARTBEAT
========================================================= */

const heartbeatInterval =
  setInterval(
    () => {

      for (
        const ws
        of wss.clients
      ) {

        if (
          ws.isAlive ===
          false
        ) {

          console.log(
            `[HEARTBEAT] encerrando conexão ${ws.id}`
          );

          ws.terminate();

          continue;
        }

        ws.isAlive =
          false;

        try {
          ws.ping();

        } catch (error) {

          console.error(
            "[HEARTBEAT]",
            error
          );
        }
      }

    },
    30000
  );

wss.on(
  "close",
  () => {
    clearInterval(
      heartbeatInterval
    );
  }
);

/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "========================================"
    );

    console.log(
      " ScreenCast Signaling Server"
    );

    console.log(
      ` Porta: ${PORT}`
    );

    console.log(
      ` Max producers: ${MAX_PRODUCERS}`
    );

    console.log(
      " Display Name: ENABLED"
    );

    console.log(
      " Duplicate protection: ENABLED"
    );

    console.log(
      "========================================"
    );
  }
);
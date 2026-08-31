import http from "node:http";
import crypto from "node:crypto";

import express from "express";
import cors from "cors";

import {
  WebSocketServer
} from "ws";

/* =========================================================
   CONFIG
========================================================= */

const PORT =
  process.env.PORT || 8787;

const MAX_PRODUCERS = 3;

/* =========================================================
   APP
========================================================= */

const app = express();

const server =
  http.createServer(app);

app.use(
  cors({
    origin: "*",
    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ]
  })
);

app.use(
  express.json()
);

/* =========================================================
   WEBSOCKET
========================================================= */

const wss =
  new WebSocketServer({
    server,
    perMessageDeflate: false
  });

/*
 * roomId -> room
 *
 * room = {
 *   id,
 *   clients: Set<WebSocket>,
 *   producers: Map<clientId, WebSocket>
 * }
 */
const rooms = new Map();

/* =========================================================
   HTTP
========================================================= */

app.get("/", (_, res) => {
  res.json({
    ok: true,
    service:
      "ScreenCast Signaling Server",
    maxProducers:
      MAX_PRODUCERS,
    websocket: true
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service:
      "screencast-signaling",
    rooms: rooms.size,
    maxProducers:
      MAX_PRODUCERS,
    uptime:
      Math.floor(
        process.uptime()
      )
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
        return res
          .status(500)
          .json({
            error:
              "TURN não configurado no servidor."
          });
      }

      const response =
        await fetch(
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

        return res
          .status(500)
          .json({
            error:
              "Não foi possível gerar credenciais TURN."
          });
      }

      return res.json(data);

    } catch (error) {
      console.error(
        "[TURN] Erro:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Erro interno ao gerar TURN."
        });
    }
  }
);

/* =========================================================
   HELPERS
========================================================= */

function send(ws, message) {
  if (
    !ws ||
    ws.readyState !== 1
  ) {
    return false;
  }

  try {
    ws.send(
      JSON.stringify(message)
    );

    return true;

  } catch (error) {
    console.error(
      "[SEND] Erro:",
      error
    );

    return false;
  }
}

function broadcast(
  room,
  message,
  except = null
) {
  if (!room) {
    return;
  }

  for (
    const client of room.clients
  ) {
    if (
      client === except
    ) {
      continue;
    }

    send(
      client,
      message
    );
  }
}

function getProducerList(room) {
  if (!room) {
    return [];
  }

  return Array.from(
    room.producers.keys()
  );
}

function findClient(
  room,
  id
) {
  if (!room || !id) {
    return null;
  }

  for (
    const client of room.clients
  ) {
    if (
      client.id === id
    ) {
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

  for (
    let i = 0;
    i < 6;
    i++
  ) {
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
  } while (
    rooms.has(code)
  );

  return code;
}

/* =========================================================
   ROOM UPDATES
========================================================= */

function updateProducerList(
  room
) {
  if (!room) {
    return;
  }

  const producers =
    getProducerList(room);

  console.log(
    `[ROOM ${room.id}] Produtores:`,
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

function getViewerCount(
  room
) {
  if (!room) {
    return 0;
  }

  let viewers = 0;

  for (
    const client of room.clients
  ) {
    if (
      !room.producers.has(
        client.id
      )
    ) {
      viewers++;
    }
  }

  return viewers;
}

function updateViewerCount(
  room
) {
  if (!room) {
    return;
  }

  const count =
    getViewerCount(room);

  console.log(
    `[ROOM ${room.id}] Viewers: ${count}`
  );

  broadcast(
    room,
    {
      type:
        "viewer-count",

      count
    }
  );
}

/* =========================================================
   PRODUCER
========================================================= */

function removeProducer(
  ws
) {
  const room =
    ws.room;

  if (!room) {
    return false;
  }

  if (
    !room.producers.has(
      ws.id
    )
  ) {
    ws.isProducer =
      false;

    return false;
  }

  console.log(
    `[PRODUCER] ${ws.id} parou de transmitir em ${room.id}`
  );

  room.producers.delete(
    ws.id
  );

  ws.isProducer =
    false;

  /*
   * Avisa todos os outros clientes
   * que essa transmissão desapareceu.
   */
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

  updateProducerList(
    room
  );

  updateViewerCount(
    room
  );

  return true;
}

/* =========================================================
   LEAVE ROOM
========================================================= */

function leaveRoom(
  ws
) {
  const room =
    ws.room;

  if (!room) {
    return;
  }

  console.log(
    `[ROOM] ${ws.id} saindo de ${room.id}`
  );

  /*
   * Se estava transmitindo,
   * remove primeiro.
   */
  if (
    room.producers.has(
      ws.id
    )
  ) {
    room.producers.delete(
      ws.id
    );

    ws.isProducer =
      false;

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
  }

  room.clients.delete(
    ws
  );

  ws.room =
    null;

  ws.isProducer =
    false;

  /*
   * Se ninguém ficou,
   * destrói a sala.
   */
  if (
    room.clients.size === 0
  ) {
    rooms.delete(
      room.id
    );

    console.log(
      `[ROOM] ${room.id} removida`
    );

    return;
  }

  updateProducerList(
    room
  );

  updateViewerCount(
    room
  );
}

/* =========================================================
   WEBSOCKET CONNECTION
========================================================= */

wss.on(
  "connection",
  ws => {
    ws.id =
      crypto.randomUUID();

    ws.room =
      null;

    ws.isProducer =
      false;

    ws.isAlive =
      true;

    console.log(
      `[CONNECT] ${ws.id}`
    );

    /*
     * Primeiro pacote enviado ao cliente.
     */
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
        ws.isAlive =
          true;
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

          send(
            ws,
            {
              type:
                "error",

              message:
                "Mensagem inválida."
            }
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

          console.log(
            `[ROOM] criada: ${roomId} por ${ws.id}`
          );

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
                1
            }
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
              msg.roomId || ""
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

          if (
            ws.room &&
            ws.room !== room
          ) {
            leaveRoom(ws);
          }

          /*
           * Evita adicionar duas vezes.
           */
          if (
            !room.clients.has(ws)
          ) {
            room.clients.add(
              ws
            );
          }

          ws.room =
            room;

          ws.isProducer =
            room.producers.has(
              ws.id
            );

          console.log(
            `[ROOM] ${ws.id} entrou em ${roomId}`
          );

          send(
            ws,
            {
              type:
                "room-joined",

              roomId
            }
          );

          /*
           * Envia a lista atual
           * imediatamente para o novo cliente.
           */
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

          /*
           * Atualiza os outros clientes.
           */
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
           * Já está transmitindo.
           */
          if (
            room.producers.has(
              ws.id
            )
          ) {
            return;
          }

          /*
           * Limite de transmissões.
           */
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

          room.producers.set(
            ws.id,
            ws
          );

          ws.isProducer =
            true;

          console.log(
            `[PRODUCER] ${ws.id} começou a transmitir em ${room.id}`
          );

          /*
           * Avisa os espectadores
           * sobre o novo produtor.
           */
          broadcast(
            room,
            {
              type:
                "producer",

              producerId:
                ws.id
            },
            ws
          );

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
          removeProducer(ws);

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
              msg.producerId || ""
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

          /*
           * Não permite produtor
           * pedir offer dele mesmo.
           */
          if (
            producer.id ===
            ws.id
          ) {
            return;
          }

          console.log(
            `[SIGNAL] ${ws.id} pediu offer de ${producer.id}`
          );

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
              msg.target || ""
            );

          if (!targetId) {
            console.warn(
              "[OFFER] target ausente"
            );

            return;
          }

          const target =
            findClient(
              room,
              targetId
            );

          if (!target) {
            console.warn(
              "[OFFER] target não encontrado:",
              targetId
            );

            return;
          }

          /*
           * Apenas um produtor pode
           * enviar uma offer.
           */
          if (
            !room.producers.has(
              ws.id
            )
          ) {
            console.warn(
              `[OFFER] ${ws.id} não é produtor`
            );

            return;
          }

          if (
            !msg.offer
          ) {
            console.warn(
              "[OFFER] SDP ausente"
            );

            return;
          }

          console.log(
            `[SIGNAL] OFFER ${ws.id} -> ${target.id}`
          );

          send(
            target,
            {
              type:
                "offer",

              from:
                ws.id,

              producerId:
                ws.id,

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
              msg.target || ""
            );

          if (!targetId) {
            console.warn(
              "[ANSWER] target ausente"
            );

            return;
          }

          const target =
            findClient(
              room,
              targetId
            );

          if (!target) {
            console.warn(
              "[ANSWER] target não encontrado:",
              targetId
            );

            return;
          }

          if (!msg.answer) {
            console.warn(
              "[ANSWER] SDP ausente"
            );

            return;
          }

          console.log(
            `[SIGNAL] ANSWER ${ws.id} -> ${target.id}`
          );

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
              msg.target || ""
            );

          const producerId =
            String(
              msg.producerId || ""
            );

          if (!targetId) {
            console.warn(
              "[ICE] target ausente"
            );

            return;
          }

          if (!producerId) {
            console.warn(
              "[ICE] producerId ausente"
            );

            return;
          }

          if (!msg.candidate) {
            return;
          }

          const target =
            findClient(
              room,
              targetId
            );

          if (!target) {
            console.warn(
              "[ICE] target não encontrado:",
              targetId
            );

            return;
          }

          /*
           * O producerId precisa representar
           * um produtor REALMENTE ativo.
           */
          if (
            !room.producers.has(
              producerId
            )
          ) {
            console.warn(
              `[ICE] produtor ${producerId} não está ativo`
            );

            return;
          }

          /*
           * O próprio produtor pode enviar
           * ICE para o viewer e o viewer pode
           * enviar ICE para o produtor.
           *
           * Apenas retransmitimos.
           */
          console.log(
            `[SIGNAL] ICE ${ws.id} -> ${target.id} | producer=${producerId}`
          );

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
           UNKNOWN MESSAGE
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
      () => {
        console.log(
          `[DISCONNECT] ${ws.id}`
        );

        leaveRoom(ws);
      }
    );

    /* =====================================================
       ERROR
    ===================================================== */

    ws.on(
      "error",
      error => {
        console.error(
          `[WS ERROR] ${ws.id}:`,
          error
        );
      }
    );
  }
);

/* =========================================================
   WEBSOCKET HEARTBEAT
========================================================= */

const heartbeat =
  setInterval(
    () => {
      for (
        const ws of wss.clients
      ) {
        if (
          ws.isAlive === false
        ) {
          console.warn(
            `[HEARTBEAT] encerrando conexão ${ws.id}`
          );

          try {
            ws.terminate();
          } catch {}

          continue;
        }

        ws.isAlive =
          false;

        try {
          ws.ping();
        } catch {}
      }
    },
    30000
  );

wss.on(
  "close",
  () => {
    clearInterval(
      heartbeat
    );
  }
);

/* =========================================================
   SERVER START
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
      "========================================"
    );

    console.log(
      `Porta: ${PORT}`
    );

    console.log(
      `Máximo de produtores: ${MAX_PRODUCERS}`
    );

    console.log(
      "WebSocket: ATIVO"
    );

    console.log(
      "TURN endpoint: /turn-credentials"
    );

    console.log(
      "Health: /health"
    );

    console.log(
      "========================================"
    );
  }
);

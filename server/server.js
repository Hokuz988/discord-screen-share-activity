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

const app =
  express();

const server =
  http.createServer(
    app
  );

app.use(
  cors({
    origin: "*"
  })
);

app.use(
  express.json()
);

const wss =
  new WebSocketServer({
    server
  });

const rooms =
  new Map();

const PORT =
  process.env.PORT ||
  8787;

const MAX_PRODUCERS =
  3;

/* =========================================================
   HTTP
========================================================= */

app.get(
  "/",
  (_, res) => {
    res.json({
      ok: true,

      service:
        "ScreenCast Signaling Server",

      maxProducers:
        MAX_PRODUCERS
    });
  }
);

app.get(
  "/health",
  (_, res) => {
    res.json({
      ok: true,

      service:
        "screencast-signaling",

      rooms:
        rooms.size,

      maxProducers:
        MAX_PRODUCERS
    });
  }
);

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

      if (
        !keyId ||
        !apiToken
      ) {
        return res
          .status(500)
          .json({
            error:
              "TURN não configurado no servidor"
          });
      }

      const response =
        await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
          {
            method:
              "POST",

            headers: {
              Authorization:
                `Bearer ${apiToken}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                ttl:
                  3600
              })
          }
        );

      const data =
        await response.json();

      if (
        !response.ok
      ) {
        console.error(
          "Erro Cloudflare TURN:",
          data
        );

        return res
          .status(500)
          .json({
            error:
              "Não foi possível gerar credenciais TURN"
          });
      }

      res.json(
        data
      );
    } catch (error) {
      console.error(
        "Erro ao gerar TURN:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Erro interno ao gerar TURN"
        });
    }
  }
);

/* =========================================================
   UTILIDADES
========================================================= */

function send(
  ws,
  message
) {
  if (
    ws &&
    ws.readyState === 1
  ) {
    try {
      ws.send(
        JSON.stringify(
          message
        )
      );
    } catch (error) {
      console.error(
        "Erro enviando WebSocket:",
        error
      );
    }
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
    const client of
    room.clients
  ) {
    if (
      client !== except &&
      client.readyState === 1
    ) {
      send(
        client,
        message
      );
    }
  }
}

function getProducerList(
  room
) {
  if (!room) {
    return [];
  }

  return Array.from(
    room.producers.keys()
  );
}

function updateProducerList(
  room
) {
  if (!room) {
    return;
  }

  const producers =
    getProducerList(
      room
    );

  console.log(
    `[ROOM] ${room.id} produtores:`,
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

function viewerCount(
  room
) {
  if (!room) {
    return 0;
  }

  return Math.max(
    0,
    room.clients.size -
      room.producers.size
  );
}

function updateViewerCount(
  room
) {
  if (!room) {
    return;
  }

  broadcast(
    room,
    {
      type:
        "viewer-count",

      count:
        viewerCount(
          room
        )
    }
  );
}

function findClient(
  room,
  id
) {
  if (!room) {
    return null;
  }

  for (
    const client of
    room.clients
  ) {
    if (
      client.id ===
      id
    ) {
      return client;
    }
  }

  return null;
}

function generateRoomCode() {
  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code =
    "";

  for (
    let i = 0;
    i < 6;
    i++
  ) {
    code +=
      characters[
        Math.floor(
          Math.random() *
          characters.length
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
   REMOVER PRODUTOR
========================================================= */

function removeProducer(
  ws,
  notify = true
) {
  const room =
    ws.room;

  if (!room) {
    return;
  }

  if (
    !room.producers.has(
      ws.id
    )
  ) {
    return;
  }

  room.producers.delete(
    ws.id
  );

  ws.isProducer =
    false;

  console.log(
    `[PRODUCER] ${ws.id} parou de transmitir em ${room.id}`
  );

  if (notify) {
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
  }
}

/* =========================================================
   SAIR DA SALA
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

  updateProducerList(
    room
  );

  updateViewerCount(
    room
  );

  if (
    room.clients.size ===
    0
  ) {
    rooms.delete(
      room.id
    );

    console.log(
      `[ROOM] Sala removida: ${room.id}`
    );
  }
}

/* =========================================================
   WEBSOCKET
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
            "[ERROR] JSON inválido"
          );

          return;
        }

        console.log(
          `[MESSAGE] ${ws.id} -> ${msg.type}`
        );

        /* =================================================
           CRIAR SALA
        ================================================= */

        if (
          msg.type ===
          "create-room"
        ) {
          if (ws.room) {
            leaveRoom(
              ws
            );
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
            `[ROOM] Criada: ${roomId}`
          );

          return;
        }

        /* =================================================
           ENTRAR
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
            leaveRoom(
              ws
            );
          }

          room.clients.add(
            ws
          );

          ws.room =
            room;

          send(
            ws,
            {
              type:
                "room-joined",

              roomId
            }
          );

          /*
           * Envia produtores existentes
           * diretamente para o novo cliente.
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
                viewerCount(
                  room
                )
            }
          );

          /*
           * Atualiza os clientes antigos.
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

          broadcast(
            room,
            {
              type:
                "viewer-count",

              count:
                viewerCount(
                  room
                )
            },
            ws
          );

          console.log(
            `[ROOM] ${ws.id} entrou em ${roomId}`
          );

          return;
        }

        /* =================================================
           SAIR
        ================================================= */

        if (
          msg.type ===
          "leave-room"
        ) {
          leaveRoom(
            ws
          );

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
           COMEÇAR TRANSMISSÃO
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

          if (
            room.producers.has(
              ws.id
            )
          ) {
            send(
              ws,
              {
                type:
                  "error",

                message:
                  "Você já está transmitindo."
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
           * REGISTRA O PRODUTOR.
           */
          room.producers.set(
            ws.id,
            ws
          );

          ws.isProducer =
            true;

          console.log(
            `[PRODUCER] ${ws.id} transmitindo em ${room.id}`
          );

          /*
           * Avisa os outros.
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

          /*
           * Atualiza todos.
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
           PARAR
        ================================================= */

        if (
          msg.type ===
          "stop-sharing"
        ) {
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
            console.warn(
              "Target da offer não encontrado:",
              targetId
            );

            return;
          }

          if (
            !room.producers.has(
              ws.id
            )
          ) {
            console.warn(
              "Offer rejeitada:",
              ws.id
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
            console.warn(
              "Target da answer não encontrado:",
              targetId
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

          const producerId =
            String(
              msg.producerId ||
              ""
            );

          if (!producerId) {
            return;
          }

          /*
           * O produtor precisa existir.
           */
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

        leaveRoom(
          ws
        );
      }
    );

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
   START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `ScreenCast server rodando na porta ${PORT}`
    );

    console.log(
      `Máximo de transmissões por sala: ${MAX_PRODUCERS}`
    );
  }
);
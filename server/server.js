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

      if (!response.ok) {
        console.error(
          "[TURN] Cloudflare:",
          data
        );

        return res
          .status(500)
          .json({
            error:
              "Não foi possível gerar credenciais TURN"
          });
      }

      return res.json(
        data
      );

    } catch (error) {
      console.error(
        "[TURN]",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Erro interno ao gerar TURN"
        });
    }
  }
);

/* =========================================================
   SEND
========================================================= */

function send(
  ws,
  message
) {
  if (
    !ws ||
    ws.readyState !== 1
  ) {
    return;
  }

  try {
    ws.send(
      JSON.stringify(
        message
      )
    );
  } catch (error) {
    console.error(
      "[SEND]",
      error
    );
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

  for (
    const client
    of room.clients
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

/* =========================================================
   PRODUCERS
========================================================= */

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
  const producers =
    getProducerList(
      room
    );

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
   VIEWER COUNT
========================================================= */

function getViewerCount(
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
  broadcast(
    room,
    {
      type:
        "viewer-count",

      count:
        getViewerCount(
          room
        )
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
  if (!room) {
    return null;
  }

  for (
    const client
    of room.clients
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

/* =========================================================
   ROOM CODE
========================================================= */

function generateRoomCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code =
    "";

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
    rooms.has(
      code
    )
  );

  return code;
}

/* =========================================================
   REMOVE PRODUCER
========================================================= */

function removeProducer(
  ws
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

  console.log(
    `[PRODUCER] REMOVENDO ${ws.id} DA SALA ${room.id}`
  );

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

  updateProducerList(
    room
  );

  updateViewerCount(
    room
  );
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

  if (
    room.clients.size >
    0
  ) {
    updateProducerList(
      room
    );

    updateViewerCount(
      room
    );

  } else {
    rooms.delete(
      room.id
    );

    console.log(
      `[ROOM] ${room.id} removida`
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
            "[MESSAGE] JSON inválido"
          );

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
            `[ROOM] criada: ${roomId}`
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
            `[ROOM] ${ws.id} entrou em ${roomId}`
          );

          return;
        }

        /* =================================================
           LEAVE
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

          if (
            room.producers.has(
              ws.id
            )
          ) {
            console.log(
              `[PRODUCER] ${ws.id} já é produtor`
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

          room.producers.set(
            ws.id,
            ws
          );

          ws.isProducer =
            true;

          console.log(
            `[PRODUCER] ${ws.id} COMEÇOU A TRANSMITIR`
          );

          console.log(
            `[PRODUCER] produtores atuais:`,
            getProducerList(
              room
            )
          );

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
              "[OFFER] target não encontrado:",
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
              "[OFFER] cliente não é produtor:",
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
              "[ANSWER] target não encontrado:",
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
            console.warn(
              "[ICE] target ausente"
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
              "[ICE] target não encontrado:",
              targetId
            );

            return;
          }

          const producerId =
            String(
              msg.producerId ||
              ""
            );

          if (!producerId) {
            console.warn(
              "[ICE] producerId ausente"
            );

            return;
          }

          /*
           * O producerId precisa ser um produtor
           * ativo na sala.
           */
          if (
            !room.producers.has(
              producerId
            )
          ) {
            console.warn(
              `[ICE] produtor ${producerId} não está mais ativo`
            );

            return;
          }

          /*
           * Não altera o candidate.
           * Apenas repassa para o outro cliente.
           */
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
      `Máximo de transmissões: ${MAX_PRODUCERS}`
    );
  }
);
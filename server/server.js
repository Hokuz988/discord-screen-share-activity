import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";

const app = express();

const server = http.createServer(app);

const PORT = process.env.PORT || 8787;

const MAX_PRODUCERS = 3;

/* =========================================================
   EXPRESS
========================================================= */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json());

/* =========================================================
   WEBSOCKET
========================================================= */

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false
});

/* =========================================================
   SALAS
========================================================= */

/*
room = {
  id,
  clients: Set<WebSocket>,
  producers: Map<producerId, WebSocket>
}
*/

const rooms = new Map();

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
  res.status(200).json({
    ok: true,
    service: "screencast-signaling",
    rooms: rooms.size,
    maxProducers: MAX_PRODUCERS,
    uptime: process.uptime()
  });
});

/* =========================================================
   CLOUDFLARE TURN
========================================================= */

app.get("/turn-credentials", async (_, res) => {
  try {
    const keyId =
      process.env.TURN_KEY_ID;

    const apiToken =
      process.env.TURN_API_TOKEN;

    if (!keyId || !apiToken) {
      return res.status(500).json({
        error: "TURN não configurado no servidor"
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
        "[TURN] Erro Cloudflare:",
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
      "[TURN] Erro:",
      error
    );

    return res.status(500).json({
      error:
        "Erro interno ao gerar TURN"
    });
  }
});

/* =========================================================
   UTILIDADES
========================================================= */

function send(ws, message) {

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
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
      "[WS] Erro ao enviar:",
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

  for (
    const client
    of room.clients
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

/* =========================================================
   LISTA DE PRODUTORES
========================================================= */

function getProducerList(room) {

  if (!room) {
    return [];
  }

  return Array.from(
    room.producers.keys()
  );
}

/* =========================================================
   ATUALIZAR PRODUTORES
========================================================= */

function updateProducerList(room) {

  if (!room) {
    return;
  }

  const producers =
    getProducerList(room);

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

/* =========================================================
   VIEWERS
========================================================= */

function viewerCount(room) {

  if (!room) {
    return 0;
  }

  /*
   * Conta pessoas que não estão
   * transmitindo.
   */

  return Math.max(
    0,

    room.clients.size -
      room.producers.size
  );
}

/* =========================================================
   ATUALIZAR VIEWERS
========================================================= */

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
        viewerCount(room)
    }
  );
}

/* =========================================================
   ENCONTRAR CLIENTE
========================================================= */

function findClient(
  room,
  id
) {

  if (!room || !id) {
    return null;
  }

  for (
    const client
    of room.clients
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

  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

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

/* =========================================================
   CRIAR ROOM CODE
========================================================= */

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

function leaveRoom(ws) {

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
   * remove a transmissão.
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

  /*
   * Remove cliente.
   */

  room.clients.delete(
    ws
  );

  ws.room =
    null;

  ws.isProducer =
    false;

  /*
   * Atualiza todos.
   */

  updateProducerList(
    room
  );

  updateViewerCount(
    room
  );

  /*
   * Se não sobrou ninguém,
   * remove a sala.
   */

  if (
    room.clients.size === 0
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
   WEBSOCKET CONNECTION
========================================================= */

wss.on(
  "connection",
  (ws, request) => {

    /*
     * ID único deste usuário.
     */

    ws.id =
      crypto.randomUUID();

    /*
     * Sala atual.
     */

    ws.room =
      null;

    /*
     * Se está transmitindo.
     */

    ws.isProducer =
      false;

    /*
     * Keep alive.
     */

    ws.isAlive =
      true;

    console.log(
      `[CONNECT] ${ws.id}`
    );

    /*
     * Envia o ID imediatamente.
     *
     * Isso é importante porque
     * o frontend usa myId.current.
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
       PONG
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
            `[ERROR] JSON inválido de ${ws.id}`
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

          send(
            ws,
            {
              type:
                "room-created",

              roomId
            }
          );

          /*
           * Envia lista vazia.
           */

          send(
            ws,
            {
              type:
                "producer-list",

              producers: []
            }
          );

          send(
            ws,
            {
              type:
                "viewer-count",

              count:
                viewerCount(room)
            }
          );

          console.log(
            `[ROOM] Criada: ${roomId}`
          );

          return;
        }

        /* =================================================
           ENTRAR NA SALA
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

          /*
           * Se já estava em outra
           * sala, sai primeiro.
           */

          if (ws.room) {
            leaveRoom(ws);
          }

          /*
           * Adiciona à sala.
           */

          room.clients.add(
            ws
          );

          ws.room =
            room;

          /*
           * Confirma entrada.
           */

          send(
            ws,
            {
              type:
                "room-joined",

              roomId
            }
          );

          /*
           * MUITO IMPORTANTE:
           *
           * Envia TODAS as transmissões
           * atuais.
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

          /*
           * Envia quantidade de viewers.
           */

          send(
            ws,
            {
              type:
                "viewer-count",

              count:
                viewerCount(room)
            }
          );

          /*
           * Atualiza o restante
           * da sala.
           */

          updateProducerList(
            room
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
           SAIR
        ================================================= */

        if (
          msg.type ===
          "leave-room"
        ) {

          const oldRoom =
            ws.room;

          leaveRoom(ws);

          send(
            ws,
            {
              type:
                "left-room"
            }
          );

          if (oldRoom) {

            console.log(
              `[ROOM] ${ws.id} saiu`
            );
          }

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
           * Já transmite?
           */

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

          /*
           * Limite global.
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

          /*
           * Adiciona produtor.
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
           * Atualiza lista.
           */

          updateProducerList(
            room
          );

          updateViewerCount(
            room
          );

          /*
           * Também confirma
           * para o próprio produtor.
           *
           * Isso ajuda o frontend
           * a manter a lista correta.
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

          return;
        }

        /* =================================================
           STOP SHARING
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
            msg.producerId;

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
           * O espectador pede ao produtor
           * para criar uma conexão.
           */

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

          const target =
            findClient(
              room,
              msg.target
            );

          if (!target) {

            console.warn(
              `[OFFER] Target não encontrado: ${msg.target}`
            );

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
                msg.producerId ||
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

          const target =
            findClient(
              room,
              msg.target
            );

          if (!target) {

            console.warn(
              `[ANSWER] Target não encontrado: ${msg.target}`
            );

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

          const target =
            findClient(
              room,
              msg.target
            );

          if (!target) {

            console.warn(
              `[ICE] Target não encontrado: ${msg.target}`
            );

            return;
          }

          send(
            target,
            {
              type:
                "ice",

              from:
                ws.id,

              producerId:
                msg.producerId,

              candidate:
                msg.candidate
            }
          );

          return;
        }

        /* =================================================
           PING MANUAL
        ================================================= */

        if (
          msg.type ===
          "ping"
        ) {

          send(
            ws,
            {
              type:
                "pong"
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
      (code, reason) => {

        console.log(
          `[DISCONNECT] ${ws.id} code=${code} reason=${reason?.toString() || ""}`
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
   WEBSOCKET KEEP ALIVE
========================================================= */

/*
 * Render/proxies podem fechar conexões
 * WebSocket consideradas inativas.
 *
 * Este intervalo verifica todos os clientes.
 */

const heartbeatInterval =
  setInterval(
    () => {

      for (
        const ws
        of wss.clients
      ) {

        if (
          ws.isAlive === false
        ) {

          console.log(
            `[WS] Encerrando conexão inativa: ${ws.id}`
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
    25000
  );

/*
 * Não deixa o timer impedir
 * o processo de finalizar.
 */

heartbeatInterval.unref?.();

/* =========================================================
   WEBSOCKET ERROR
========================================================= */

wss.on(
  "error",
  error => {

    console.error(
      "[WSS ERROR]",
      error
    );
  }
);

/* =========================================================
   HTTP SERVER ERROR
========================================================= */

server.on(
  "error",
  error => {

    console.error(
      "[SERVER ERROR]",
      error
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
      ` Máximo de produtores: ${MAX_PRODUCERS}`
    );

    console.log(
      " WebSocket: ATIVO"
    );

    console.log(
      " TURN: Cloudflare"
    );

    console.log(
      "========================================"
    );
  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown(
  signal
) {

  console.log(
    `[SERVER] ${signal} recebido. Encerrando...`
  );

  for (
    const ws
    of wss.clients
  ) {

    try {

      ws.close(
        1001,
        "Servidor encerrando"
      );

    } catch {}
  }

  clearInterval(
    heartbeatInterval
  );

  server.close(
    () => {

      console.log(
        "[SERVER] Encerrado."
      );

      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
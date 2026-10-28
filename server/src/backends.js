import fs from "node:fs/promises";
import path from "node:path";

/* =========================================================
   BACKENDS DE PERSISTÊNCIA
   O store mantém tudo em memória e chama estes métodos a cada
   mudança. Os registros já chegam cifrados.
========================================================= */

/* ---------------- ARQUIVO (desenvolvimento) ---------------- */

export function fileBackend(dataDir) {
  const file = path.join(dataDir, "store.json");

  let snapshot = { users: {}, sessions: {} };
  let queue = Promise.resolve();

  function flush() {
    const json = JSON.stringify(snapshot);

    queue = queue
      .then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;

        await fs.writeFile(tmp, json, { mode: 0o600 });
        await fs.rename(tmp, file);
      })
      .catch(error => {
        console.error("[STORE] falha ao salvar:", error.message);
      });

    return queue;
  }

  return {
    name: `arquivo (${file})`,

    async load() {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

      try {
        snapshot = JSON.parse(await fs.readFile(file, "utf8"));
        snapshot.users ||= {};
        snapshot.sessions ||= {};
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      return snapshot;
    },

    saveUser(user) {
      snapshot.users[user.id] = user;
      return flush();
    },

    saveSession(hash, session) {
      snapshot.sessions[hash] = session;
      return flush();
    },

    deleteSessions(hashes) {
      for (const hash of hashes) {
        delete snapshot.sessions[hash];
      }

      return flush();
    }
  };
}

/* ---------------- POSTGRES (produção) ---------------- */

export async function postgresBackend(connectionString) {
  const { default: pg } = await import("pg");

  const pool = new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000
  });

  pool.on("error", error => {
    console.error("[STORE] postgres:", error.message);
  });

  return {
    name: "postgres",

    async load() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS screencast_users (
          id   TEXT PRIMARY KEY,
          data JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS screencast_sessions (
          hash TEXT PRIMARY KEY,
          data JSONB NOT NULL
        );
      `);

      await pool.query(
        "DELETE FROM screencast_sessions WHERE (data->>'expiresAt')::bigint < $1",
        [Date.now()]
      );

      const users = {};
      const sessions = {};

      for (const row of (await pool.query("SELECT id, data FROM screencast_users")).rows) {
        users[row.id] = row.data;
      }

      for (const row of (await pool.query("SELECT hash, data FROM screencast_sessions")).rows) {
        sessions[row.hash] = row.data;
      }

      return { users, sessions };
    },

    async saveUser(user) {
      await pool.query(
        `INSERT INTO screencast_users (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [user.id, user]
      );
    },

    async saveSession(hash, session) {
      await pool.query(
        `INSERT INTO screencast_sessions (hash, data) VALUES ($1, $2)
         ON CONFLICT (hash) DO UPDATE SET data = EXCLUDED.data`,
        [hash, session]
      );
    },

    async deleteSessions(hashes) {
      if (hashes.length > 0) {
        await pool.query(
          "DELETE FROM screencast_sessions WHERE hash = ANY($1)",
          [hashes]
        );
      }
    }
  };
}

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiscordSDK } from "@discord/embedded-app-sdk";

import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./style.css";

import { api, getToken, IN_DISCORD, setToken } from "./lib/api.js";
import { googleSignOut } from "./lib/google.js";
import { useRoom } from "./hooks/useRoom.js";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { Lobby } from "./components/Lobby.jsx";
import { Room } from "./components/Room.jsx";

/* =========================================================
   DISCORD
========================================================= */

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || "";

function useDiscord() {
  useEffect(() => {
    if (!DISCORD_CLIENT_ID || !IN_DISCORD) {
      return;
    }

    new DiscordSDK(DISCORD_CLIENT_ID)
      .ready()
      .catch(error => console.warn("[DISCORD]", error));
  }, []);
}

/* =========================================================
   APP
========================================================= */

function SignedIn({ token, user, onLogout, onExpired }) {
  const room = useRoom({ token, onUnauthorized: onExpired });

  if (room.room) {
    return <Room room={room} />;
  }

  return <Lobby user={user} room={room} onLogout={onLogout} />;
}

function App() {
  useDiscord();

  const [token, setTokenState] = useState(getToken);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));

  const signOutLocally = useCallback(() => {
    setToken("");
    setTokenState("");
    setUser(null);
    googleSignOut();
  }, []);

  useEffect(() => {
    if (!token || user) {
      setChecking(false);
      return;
    }

    let alive = true;

    api.me()
      .then(data => alive && setUser(data.user))
      .catch(error => {
        if (alive && error.status === 401) {
          signOutLocally();
        }
      })
      .finally(() => alive && setChecking(false));

    return () => {
      alive = false;
    };
  }, [token]);

  function handleAuthenticated(nextToken, nextUser) {
    setToken(nextToken);
    setUser(nextUser);
    setTokenState(nextToken);
  }

  async function logout() {
    try {
      await api.logout();
    } catch {}

    signOutLocally();
  }

  if (checking) {
    return (
      <div className="boot">
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  if (!token || !user) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <SignedIn
      token={token}
      user={user}
      onLogout={logout}
      onExpired={signOutLocally}
    />
  );
}

/* =========================================================
   ROOT
========================================================= */

createRoot(document.getElementById("root")).render(<App />);

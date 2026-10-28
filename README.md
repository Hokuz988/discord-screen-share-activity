# ScreenCast — Discord Activity

Compartilhamento de tela com até 3 transmissões simultâneas, contas de usuário
(e-mail/senha ou Google) e criptografia ponta a ponta.

## Estrutura

```
client/src/
  main.jsx            App: sessão, troca de telas
  hooks/useRoom.js    Sinalização + WebRTC
  lib/api.js          Chamadas HTTP e token de sessão
  lib/e2e.js          Criptografia da sala (convite, AES-GCM)
  lib/google.js       Botão "Continuar com Google"
  components/         AuthScreen, Lobby, Room, TopBar, Icons
server/
  server.js           Express + WebSocket
  src/auth.js         Cadastro, login, Google, sessões
  src/signaling.js    Salas e repasse de sinais cifrados
  src/security.js     scrypt, AES-256-GCM, HMAC, rate limit
  src/store.js        Armazenamento (JSON cifrado)
```

## Segurança

| O quê | Como |
|---|---|
| Vídeo/áudio | WebRTC (DTLS-SRTP), ponta a ponta entre navegadores |
| Sinalização | Ofertas/respostas cifradas com AES-256-GCM usando a chave do convite. O servidor não vê SDP/IPs e não consegue fazer MITM |
| Convite | `CÓDIGO.CHAVE` — a chave (256 bits) nunca vai ao servidor; ele só recebe um HMAC derivado para barrar quem não tem o convite |
| Senhas | HMAC (pepper) + scrypt N=2¹⁶, comparação em tempo constante, bloqueio após 5 erros |
| Dados em repouso | E-mail e nome cifrados com AES-256-GCM; busca por índice cego (HMAC) |
| Sessões | Token aleatório de 256 bits; servidor guarda só o SHA-256; expira em 7 dias; logout derruba o WebSocket |
| Google | ID token verificado (assinatura, emissor, audiência, e-mail verificado). Vincular Google a uma conta existente apaga a senha antiga (evita sequestro de conta pré-criada) |
| API | Helmet, CORS e origem do WebSocket restritos, limite de payload, rate limit, TURN só para logados |
| Frontend | CSP no build, sem scripts de terceiros além do Google, fontes empacotadas |

## Rodando localmente

```bash
npm install
npm --prefix server install

cp .env.example .env
cp server/.env.example server/.env
# preencha MASTER_KEY em server/.env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

npm run dev
```

Frontend em `http://localhost:5173`, servidor em `http://localhost:8787`.

## Login com Google

1. Google Cloud Console → APIs e serviços → Credenciais → Criar ID do cliente OAuth → **Aplicativo da Web**.
2. Em **Origens JavaScript autorizadas**, adicione `http://localhost:5173` e o domínio do seu frontend.
3. Use o mesmo Client ID em `GOOGLE_CLIENT_ID` (servidor) e `VITE_GOOGLE_CLIENT_ID` (frontend).

Dentro do app do Discord o popup do Google costuma ser bloqueado; nesse caso a
tela mostra só e-mail e senha.

## Deploy

- **Frontend** (estático, `npm run build` → `dist/`): Vercel, Netlify, Cloudflare Pages.
- **Servidor** (precisa de WebSocket e processo contínuo): Render, Railway, Fly.io.
  Configure `MASTER_KEY`, `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID`, `TURN_*` e um
  disco persistente em `DATA_DIR` — sem ele as contas somem a cada deploy.

# ScreenCast — Discord Activity

MVP de uma Discord Activity para compartilhar a tela dentro da própria Activity.

## O que já existe

- UI de Activity estilo Discord
- Embedded App SDK
- botão para capturar tela/janela/aba
- WebRTC para transmitir vídeo
- servidor WebSocket para sinalização
- STUN configurado
- contagem básica de espectadores
- parada automática quando o usuário encerra a captura

## Importante

A Activity não captura a tela escondido. O navegador/cliente precisa mostrar a seleção de compartilhamento e o usuário precisa escolher o conteúdo.

Também é possível que uma conexão WebRTC precise de TURN em redes restritivas. O projeto vem com STUN para o MVP; para produção, configure um servidor TURN.

## Requisitos

- Node.js atual
- uma aplicação criada no Discord Developer Portal
- Embedded App/Activity configurada
- URL HTTPS pública para testar dentro do Discord

## Instalação

```bash
npm install
cp .env.example .env
```

Edite `.env`:

```env
VITE_DISCORD_CLIENT_ID=SEU_CLIENT_ID
VITE_SIGNALING_URL=ws://localhost:8787
```

Depois:

```bash
npm run dev
```

O frontend fica em:

```text
http://localhost:5173
```

O servidor de sinalização fica em:

```text
ws://localhost:8787
```

## Teste rápido

Você pode abrir duas abas do frontend para testar a parte WebRTC.

1. Aba A: clique em "Compartilhar tela".
2. Escolha uma tela/janela/aba.
3. Aba B: entre na mesma sala.
4. A transmissão deverá aparecer.

Para testar como Activity, siga o fluxo oficial do Discord para configurar uma aplicação e a URL do cliente.

## Próximos passos para produção

1. Autenticar usuários pelo Embedded App SDK.
2. Usar o ID do canal/instância da Activity como identificador da sala.
3. Corrigir a negociação para múltiplos espectadores de forma robusta.
4. Adicionar TURN.
5. Limitar bitrate/FPS.
6. Adicionar seleção de qualidade.
7. Adicionar áudio separado.
8. Adicionar permissões e botão "Assistir".
9. Fazer deploy HTTPS do frontend e WSS do servidor.

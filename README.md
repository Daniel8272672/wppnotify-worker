# WppNotify Worker (Node.js + whatsapp-web.js)

Worker que se conecta ao WhatsApp Web via QR Code, monitora o status dos contatos e envia eventos para o seu app WppNotify hospedado no Lovable.

## Por que separado?

`whatsapp-web.js` usa Puppeteer + Chromium headless, que não rodam em Cloudflare Workers (onde o backend do Lovable é executado). Por isso o worker precisa ser hospedado em uma VPS, Railway, Render, Fly.io ou similar.

## Setup

1. Crie um token no WppNotify (Configurações → Tokens do worker).
2. Cadastre os contatos que deseja monitorar (página Contatos).
3. Configure as variáveis abaixo e suba o worker.

## Variáveis de ambiente

```bash
WPPNOTIFY_URL=https://seu-projeto.lovable.app/api/public/ingest
WORKER_TOKEN=cole-aqui-o-token-gerado
POLL_INTERVAL_MS=15000
```

## Rodar com Docker

```bash
docker build -t wppnotify-worker .
docker run -d --name wppnotify \
  -e WPPNOTIFY_URL=... \
  -e WORKER_TOKEN=... \
  -v $(pwd)/session:/app/session \
  wppnotify-worker
```

Na primeira execução, o QR Code aparece nos logs (`docker logs -f wppnotify`). Escaneie pelo WhatsApp > Aparelhos conectados.

## Rodar localmente

```bash
npm install
node index.js
```

## Estrutura de pastas

```
worker/
├── Dockerfile
├── package.json
├── index.js          # cliente whatsapp-web.js + loop de presença
└── session/          # criado automaticamente, persiste auth
```

## Como funciona o monitoramento

`whatsapp-web.js` expõe presença via `client.getContactById(id).then(c => c.getLastSeen())` e o evento `presence_update` quando você assina `subscribeToPresence`. O worker:

1. Carrega a lista de contatos monitorados (consulta o app via REST).
2. Assina presença de cada um.
3. Sempre que muda de online↔offline, faz POST para `/api/public/ingest`.

> **Aviso**: a visibilidade de "online" depende das configurações de privacidade do contato. Se ele bloqueou "Visto por último" para todos, o WhatsApp não expõe esse dado.

## Payload de ingestão

```json
POST /api/public/ingest
Headers: x-worker-token: <token>

{
  "phone_number": "5511999998888",
  "status": "online",         // online | offline | typing | recording
  "duration_seconds": 42,
  "occurred_at": "2026-05-18T14:30:00Z"  // opcional
}
```

O app recebe, salva em `status_events`, atualiza o `last_status` do contato e dispara as notificações configuradas (Discord, Telegram, Push).

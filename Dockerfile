FROM node:20-slim

# Dependências mínimas para o worker Baileys
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev \
  && npm install --omit=dev --no-save \
    @whiskeysockets/baileys@7.0.0-rc13 \
    pino@10.3.1 \
    qrcode-terminal@0.12.0 \
  && node -e "Promise.all([import('@whiskeysockets/baileys'), import('pino'), import('qrcode-terminal')])"
COPY index.js ./

CMD ["node", "index.js"]

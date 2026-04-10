FROM node:20-slim

# Dependências do sistema necessárias para o Baileys
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia manifesto e instala dependências
COPY package*.json ./
RUN npm install --production

# Copia o código
COPY . .

# Pasta de sessão WhatsApp (será um volume no Railway)
RUN mkdir -p /app/auth_info

EXPOSE 3000

CMD ["node", "index.js"]

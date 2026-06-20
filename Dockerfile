# Usa un'immagine Node.js come base
FROM node:20-slim

# Imposta la directory di lavoro
WORKDIR /app

# Installa git, Python e pip (se necessario)
RUN apt-get update && \
    apt-get install -y git python3 python3-pip && \
    pip3 install requests --break-system-packages && \
    rm -rf /var/lib/apt/lists/*

# Copia i file del progetto
COPY package.json package-lock.json ./
RUN npm install

# Copia il resto del codice
COPY . .

# Crea directory per i dati (cache M3U + EPG in memoria per sessione; nessuna persistenza)
RUN mkdir -p /app/data && chown -R node:node /app/data

# Crea la directory temp e imposta i permessi (come nel Dockerfile di Hugging Face)
RUN mkdir -p /app/temp && \
    chmod 777 /app/temp

# Esponi la porta 10000 (usata dal server)
EXPOSE 10000

# Avvia l'add-on
CMD ["node", "index.js"]

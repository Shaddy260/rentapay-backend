# RentaPay backend - lightweight image (no Chromium/Puppeteer,
# since the whatsapp-web.js integration is currently disabled -
# see src/services/whatsapp.service.js)

FROM node:22-alpine

WORKDIR /app

# Install deps first so this layer is cached unless package*.json changes
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "src/server.js"]

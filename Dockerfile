FROM node:22-alpine

# ffmpeg provides both the `ffmpeg` and `ffprobe` binaries this app shells
# out to (via spawn(), never a shell — see src/ffmpeg/processor.js).
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN addgroup -S dropzone && adduser -S dropzone -G dropzone \
    && mkdir -p /app/downloads /app/tmp /app/data \
    && chown -R dropzone:dropzone /app
USER dropzone

ENV OUTPUT_DIR=/app/downloads \
    TEMP_DIR=/app/tmp \
    DATA_DIR=/app/data \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

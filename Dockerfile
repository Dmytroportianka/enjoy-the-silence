FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
ENV PORT=4317 HOST=0.0.0.0
EXPOSE 4317
CMD ["bun", "run", "start"]

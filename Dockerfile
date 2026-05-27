FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm install --ignore-scripts && pnpm rebuild esbuild

COPY . .

EXPOSE 8888

ENV CMD_PROXY_PORT=8888

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:8888/health').then(r=>{if(!r.ok)throw new Error(r.status);process.exit(0)}).catch(()=>process.exit(1))"

CMD ["pnpm", "dev"]

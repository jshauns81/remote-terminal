FROM node:20-bookworm-slim

# openssh-client (host/opencode tabs), docker-cli (claude tab), build tools for
# node-pty, and the Zellij static binary (the multiplexer that now owns tabs/
# panes/persistence/scrollback/resize/DA).
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client ca-certificates gnupg lsb-release curl python3 make g++ \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && curl -fsSL https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | tar xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/zellij \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV ZELLIJ_CONFIG_DIR=/app/zellij

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY zellij ./zellij
COPY public ./public

# Vendor the xterm.js dist files into public/vendor so the browser never loads
# JS from a third-party CDN for an authenticated, root-shell-bearing app.
RUN mkdir -p public/vendor/xterm public/vendor/addon-fit public/vendor/addon-web-links \
    && cp node_modules/@xterm/xterm/css/xterm.css public/vendor/xterm/ \
    && cp node_modules/@xterm/xterm/lib/xterm.js public/vendor/xterm/ \
    && cp node_modules/@xterm/addon-fit/lib/addon-fit.js public/vendor/addon-fit/ \
    && cp node_modules/@xterm/addon-web-links/lib/addon-web-links.js public/vendor/addon-web-links/

EXPOSE 7681
CMD ["node", "server/index.js"]

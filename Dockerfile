# ================================
# Stage 1: Build minishell
# ================================
FROM ubuntu:24.04 AS shell-builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY Makefile minishell.c ./

RUN make

# Declare the variable (with a fallback default just in case)
ARG USERNAME=defaultuser

# Create the user dynamically
RUN useradd -m -s /bin/bash ${USERNAME}

# Give ownership to the new user
RUN chown -R ${USERNAME}:${USERNAME} /app

# Switch to that user
USER ${USERNAME}

# Set the landing directory
WORKDIR /home/${USERNAME}


# ================================
# Stage 2: Node runtime
# ================================
FROM node:22

WORKDIR /app

# Copy frontend dependency files
COPY frontend/package*.json ./frontend/

WORKDIR /app/frontend

RUN npm install

# Copy frontend source
COPY frontend/ .

# Copy compiled minishell from builder
COPY --from=shell-builder /app/minishell /app/minishell

WORKDIR /app

EXPOSE 3000

ENV PORT=3000
ENV SHELL_BIN=/app/minishell

CMD ["node", "frontend/src/server.js"]


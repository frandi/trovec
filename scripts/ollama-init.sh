#!/bin/bash
set -e

LLM_MODELS="${LLM_MODELS:-llama3.2:1b,llama3.2:3b}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"

echo "Starting Ollama server..."
ollama serve &
SERVER_PID=$!

# Wait for server to be ready
until ollama list > /dev/null 2>&1; do
  echo "Waiting for Ollama server..."
  sleep 2
done
echo "Ollama server is ready."

pull_if_missing() {
  local model="$1"
  if ollama list | grep -q "^$model"; then
    echo "Model '$model' already exists, skipping."
  else
    echo "Pulling model '$model'..."
    ollama pull "$model"
  fi
}

IFS=',' read -ra MODELS <<< "$LLM_MODELS"
for model in "${MODELS[@]}"; do
  pull_if_missing "$model"
done
pull_if_missing "$EMBEDDING_MODEL"

echo "All models ready."

# Keep the server running in the foreground
wait $SERVER_PID

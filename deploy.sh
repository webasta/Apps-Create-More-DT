#!/usr/bin/env bash
# Update app di VPS: tarik kode terbaru dari GitHub lalu build ulang container.
# Pemakaian:  ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "File .env belum ada. Jalankan: cp .env.example .env  lalu isi nilainya." >&2
  exit 1
fi

echo "==> git pull"
git pull --ff-only origin main

echo "==> build & restart container"
docker compose up -d --build

echo "==> bersihkan image lama"
docker image prune -f >/dev/null

echo "==> status"
docker compose ps
echo "Selesai. Log: docker compose logs -f"

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

read -rp "Домен для видео (A-запись уже указывает на этот сервер), например media.safezone.kz: " DOMAIN
[ -n "$DOMAIN" ] || { echo "домен обязателен"; exit 1; }
echo "MEDIA_DOMAIN=$DOMAIN" > .env

[ -f media-jwt.key ] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out media-jwt.key 2>/dev/null
chmod 600 media-jwt.key
PUB=$(openssl pkey -in media-jwt.key -pubout | awk 'BEGIN{ORS="\\n"} {print}')
PRIV=$(awk 'BEGIN{ORS="\\n"} {print}' media-jwt.key)

[ -f bridge.env ] || cp ../bridge/.env bridge.env
sed -i '/^MEDIA_JWT_PUBLIC_KEY=/d; /^MEDIA_BRIDGE_SECRET=/d; /^PANEL_ORIGINS=/d' bridge.env
SECRET=$(openssl rand -hex 16)
{
  echo "MEDIA_JWT_PUBLIC_KEY=$PUB"
  echo "MEDIA_BRIDGE_SECRET=$SECRET"
  echo "PANEL_ORIGINS=https://safezone.vercel.app"
} >> bridge.env
chmod 600 bridge.env
mkdir -p data

if command -v ufw >/dev/null; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 8189/udp
  ufw allow 8189/tcp
  ufw allow 51820/udp
fi

echo
echo "Готово. Две переменные — в Vercel → Settings → Environment Variables:"
echo
echo "MEDIA_PUBLIC_URL=https://$DOMAIN"
echo "MEDIA_JWT_PRIVATE_KEY=$PRIV"
echo
echo "Потом: docker compose up -d --build"

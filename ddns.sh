#!/bin/bash

ZONE="ben256.com"
RECORD="home.ben256.com"

# Get current external IP
IP=$(curl -s https://ipv4.icanhazip.com)

# Get current DNS IP
OLD_IP=$(dig +short "$RECORD")

# Exit if no change
[ "$IP" = "$OLD_IP" ] && exit 0

ZONE_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=$ZONE" \
  -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
  -H "Content-Type: application/json" | jq -r '.result[0].id')

RECORD_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$RECORD" \
  -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
  -H "Content-Type: application/json" | jq -r '.result[0].id')

curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg type "A" \
    --arg name "$RECORD" \
    --arg content "$IP" \
    '{type: $type, name: $name, content: $content, ttl: 120, proxied: false}')"


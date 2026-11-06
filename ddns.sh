RECORD="home.ben256.com"

IP=$(curl -s https://ipv4.icanhazip.com | tr -d '\n')
[ -z "$IP" ] && exit 1

ZONE_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=$ZONE" \
    -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
    -H "Content-Type: application/json" | jq -r '.result[0].id')

[ -z "$ZONE_ID" ] && exit 1

A_RECORD_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=A&name=$RECORD" \
    -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
    -H "Content-Type: application/json" | jq -r '.result[0].id')

OLD_IP=$(dig +short A "$RECORD" | head -n1)

if [ "$IP" != "$OLD_IP" ]; then
    curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$A_RECORD_ID" \
        -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
        -H "Content-Type: application/json" \
        --data "$(jq -n \
            --arg type "A" \
            --arg name "$RECORD" \
            --arg content "$IP" \
            '{type: $type, name: $name, content: $content, ttl: 120, proxied: false}')"
fi

AAAA_RECORD_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=AAAA&name=$RECORD" \
    -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
    -H "Content-Type: application/json" | jq -r '.result[0].id')

if [ "$AAAA_RECORD_ID" != "null" ] && [ -n "$AAAA_RECORD_ID" ]; then
    curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$AAAA_RECORD_ID" \
        -H "Authorization: Bearer $CLOUDFLARE_DNS_TOKEN" \
        -H "Content-Type: application/json"
fi


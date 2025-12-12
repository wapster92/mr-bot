# Настройка удалённого сервера

Ниже пошаговый план, как поднять HTTPS‑точку входа на удалённом сервере, которая проксирует запросы Telegram к боту.

## 1. Требования

- Linux-сервер с публичным IP и доменом `mr-bot.example.com` (замени на свой).
- Node.js LTS (20+) и npm.
- Доступ по SSH с локальной машины.

## 2. Установка зависимостей

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/html && sudo chown www-data:www-data /var/www/html
```

Если включён `ufw`, открой HTTPS:

```bash
sudo ufw allow 'Nginx Full'
```

## 3. Проксирование локальной разработки (опционально)

Пока бот работает только локально, можно пробросить порт обратно на сервер:

```bash
ssh -NT -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:3000:localhost:3000 user@your-server
```

Так сервер будет слушать `127.0.0.1:3000` и пересылать весь трафик в локальный `localhost:3000`. Для надёжности используй `autossh` или systemd‑юнит, чтобы туннель не падал.

Как только бот будет запущен на самом сервере, эта секция не нужна — просто запускаем `npm run start`/PM2/systemd.

## 4. Nginx

1. Скопируй `deploy/nginx.conf` в `/etc/nginx/sites-available/mr-bot.conf` и замени `mr-bot.example.com` на свой домен.
2. Создай симлинк и проверь конфигурацию:

```bash
sudo ln -s /etc/nginx/sites-available/mr-bot.conf /etc/nginx/sites-enabled/mr-bot.conf
sudo nginx -t
sudo systemctl reload nginx
```

Конфиг проксирует `/telegram/webhook` и `/healthz` на `127.0.0.1:3000`, где крутится бот (локально через туннель либо как сервис на сервере).

## 5. Сертификат Let's Encrypt

После того как DNS смотрит на сервер, выпускаем сертификат:

```bash
sudo certbot --nginx -d mr-bot.example.com --non-interactive --agree-tos -m you@example.com
```

Certbot:

- создаст сертификаты в `/etc/letsencrypt/live/mr-bot.example.com/`;
- добавит `ssl_certificate`/`ssl_certificate_key` в конфиг;
- настроит автоматическое продление (`sudo systemctl list-timers | grep certbot`).

Проверить можно командой:

```bash
sudo certbot renew --dry-run
```

## 6. Бот

1. На сервере склонируй репозиторий, создай `.env` с `BOT_MODE=webhook`, `TELEGRAM_WEBHOOK_DOMAIN=https://mr-bot.example.com` и портом `3000`.
2. Установи зависимости и собери проект:

```bash
npm ci
npm run build
BOT_MODE=webhook TELEGRAM_BOT_TOKEN=... npm start
```

3. После запуска бот выполнит `setWebhook` на `https://mr-bot.example.com/telegram/webhook`, Telegram начнёт слать обновления через Nginx -> порт 3000 -> бот.

## 7. Автостарт (рекомендуется)

Используй systemd/PM2, чтобы бот и туннель поднимались при рестарте сервера. Например, systemd-юнит для бота:

```ini
[Unit]
Description=mr-bot
After=network.target

[Service]
WorkingDirectory=/opt/mr-bot
EnvironmentFile=/opt/mr-bot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Активируй:

```bash
sudo systemctl enable --now mr-bot
```

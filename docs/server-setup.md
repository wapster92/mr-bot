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

Установи deploy-hook, чтобы Nginx автоматически подхватывал новый сертификат
после успешного продления:

```bash
sudo install -m 0755 deploy/certbot/reload-nginx.sh \
  /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
```

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

### Вариант с корпоративным OpenVPN

Если GitLab/Jira доступны только через корпоративный VPN, положи на сервер:

- `runtime/openvpn/client.ovpn` или другой файл, имя которого указано в `OPENVPN_CONFIG_NAME`;
- `runtime/openvpn/auth.txt` с логином в первой строке и паролем во второй.

Запуск:

```bash
docker compose -f docker-compose.yml -f docker-compose.vpn.yml up --build -d
```

Эта схема поднимает отдельный контейнер `openvpn`, а контейнер `bot` использует его сетевой namespace. Порт `3000` публикуется на VPN-контейнере, поэтому Nginx на хосте остаётся прежним.

По умолчанию включён split-tunnel: параметр `OPENVPN_IGNORE_REDIRECT_GATEWAY=true` не даёт корпоративному VPN забрать весь дефолтный маршрут сервера. Это важно, чтобы Telegram API и публичный webhook продолжили ходить через обычный интернет сервера, а не через корпоративный периметр.

## 7. Автостарт Compose-стека

Для VPN-схемы недостаточно только `restart: unless-stopped`. При
запуске Docker после перезагрузки сервера порядок `depends_on` не учитывается:
`bot` может попытаться подключиться к network namespace ещё не запущенного
`openvpn` и остаться остановленным.

В репозитории есть systemd-template, который после запуска Docker повторно
применяет Compose-конфигурацию и поднимает весь стек в правильном порядке.
Шаблон ожидает, что репозиторий находится в `~/mr-bot` у пользователя, имя
которого указано после `@`:

```bash
sudo install -m 0644 deploy/systemd/mr-bot-compose@.service \
  /etc/systemd/system/mr-bot-compose@.service
sudo systemctl daemon-reload
sudo systemctl enable --now "mr-bot-compose@$(id -un).service"
```

Проверка:

```bash
systemctl status "mr-bot-compose@$(id -un).service"
docker compose -f docker-compose.yml -f docker-compose.vpn.yml ps
```

Юнит также перезапускает Compose-стек при `systemctl restart docker`.
Если репозиторий лежит не в `~/mr-bot`, переопредели `WorkingDirectory` через
`systemctl edit`.

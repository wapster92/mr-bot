# MR Bot (Telegram)

Телеграм-бот, который будет уведомлять команду про состояние CI и MR. Проект на Node.js + TypeScript + Telegraf.

## Подготовка окружения

1. Скопируй `.env.example` в `.env` и сними комментарии с нужных значений.
2. Укажи токен, полученный у BotFather, в `TELEGRAM_BOT_TOKEN`.
3. По умолчанию используется режим `long-polling`, что удобно для локальной разработки: просто запускаем бота и общаемся с ним напрямую.

## Скрипты

| Команда         | Назначение                              |
| --------------- | --------------------------------------- |
| `npm run dev`   | Запуск в dev-режиме (ts-node-dev)       |
| `npm run build` | Компиляция TypeScript в `dist/`         |
| `npm start`     | Запуск собранного бота из `dist/`       |

## Docker Compose

`docker-compose.yml` поднимает локальные контейнеры `bot`, `mongo` и `mongoku`. Чтобы собрать и запустить сервис:

```bash
docker compose up --build -d
```

Пересобрать только код без остановки можно через `docker compose up -d --build bot`, посмотреть логи — `docker compose logs -f bot`, перезапустить — `docker compose restart bot`.

Контейнер слушает `3000`, поэтому Nginx на той же машине просто проксирует HTTPS → `http://localhost:3000`.

### OpenVPN для корпоративных ресурсов

Если GitLab/Jira доступны только из корпоративной сети, поднимай бот через дополнительный compose-слой с OpenVPN:

```bash
docker compose -f docker-compose.yml -f docker-compose.vpn.yml up --build -d
```

Что нужно положить на сервер вне git:

- `runtime/openvpn/<имя-конфига>.ovpn`
- `runtime/openvpn/auth.txt` с двумя строками: логин и пароль

Если `.ovpn` называется не `client.ovpn`, укажи имя в `.env` через `OPENVPN_CONFIG_NAME`.

По умолчанию VPN-обёртка:

- подключает OpenVPN в отдельном контейнере;
- запускает бота в его network namespace;
- оставляет Telegram/webhook-трафик на обычном маршруте сервера через `OPENVPN_IGNORE_REDIRECT_GATEWAY=true`;
- при старте может зафиксировать корпоративные хосты через `CORP_GITLAB_IP` и `CORP_JIRA_IP`, если Docker не подхватывает DNS, пришедший из VPN;
- автоматически пытается переподключаться (`resolv-retry infinite`, `connect-retry`, `ping-restart`) и перезапускается через `restart: unless-stopped`.

Логи VPN:

```bash
docker compose -f docker-compose.yml -f docker-compose.vpn.yml logs -f openvpn
```

На production-сервере настрой systemd-автостарт всего Compose-стека по
[инструкции](docs/server-setup.md#7-автостарт-compose-стека). Это гарантирует повторное
применение Compose-зависимостей после перезагрузки хоста или Docker.

### Пользователи

- Основной источник прав доступа теперь коллекция `users` в MongoDB.
- Для первичной загрузки можно использовать `users.json` в корне проекта:

```bash
npm run import:users
```

- При первом `/start` бот сверяет username, и если пользователь разрешён, сохраняет `chat_id` в MongoDB. Поэтому каждому члену команды нужно один раз открыть бота и выполнить `/start`.

### MongoDB

- Укажи `MONGODB_URI` и `MONGODB_DB_NAME` в `.env`.
- Бот автоматически использует коллекции `users`, `merge_requests`, `review_reminders`, `notification_queue` и связанные служебные данные.

## GitLab вебхуки

- Настрой `GITLAB_WEBHOOK_PATH` (по умолчанию `/gitlab/webhook`) и `GITLAB_WEBHOOK_TOKEN` в `.env`.
- В настройках проекта/группы GitLab создай Webhook с URL `https://<домен><GITLAB_WEBHOOK_PATH>` и тем же секретом в поле "Secret Token".
- Все входящие payload'ы сохраняются в `logs/gitlab-events/<timestamp>-<event>.json`, так что можно изучить реальный JSON перед реализацией логики.
- При ударе GitLab бот проверит заголовок `X-Gitlab-Token`, залогирует тип события (`X-Gitlab-Event`) и вернёт `{status:"ok"}`. Пока логика уведомлений не реализована — можно смотреть события через логи приложения/файлы.

## Сервер и HTTPS

Инструкция по настройке Nginx, выпуску сертификата Let's Encrypt и пробросу локальной разработки через SSH лежит в [`docs/server-setup.md`](docs/server-setup.md). Там же пример готовой конфигурации (`deploy/nginx.conf`), которую нужно перенести в `/etc/nginx/sites-available`.

## Вебхуки и туннель для разработки

1. Переключи `BOT_MODE=webhook`, укажи свой публичный домен и путь (`TELEGRAM_WEBHOOK_DOMAIN`, `TELEGRAM_WEBHOOK_PATH`).
2. Для локалки нужен HTTPS-адрес, который смотрит на порт с ботом. Можно:
   - поднять туннель (`ngrok http 3000`, `cloudflared tunnel`, `localtunnel`) и подставить выданный URL в `TELEGRAM_WEBHOOK_DOMAIN`;
   - настроить SSH reverse-туннель с твоего сервера: `ssh -R 443:localhost:3000 user@server`, а на сервере настроить Nginx, который принимает HTTPS и прокидывает в обратный туннель;
   - запустить собственный `ngrokd`/`cloudflared` на сервере и использовать его как точку входа.
3. После изменения конфигурации перезапусти контейнер бота (например, `docker compose up --build bot`) — при старте бот сам вызывает `setWebhook` на указанный URL.

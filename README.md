# m4p-to-mp3

Телеграм-бот для конвертации аудио: M4A / AAC / ALAC / FLAC / WAV / OGG / OPUS / WMA / AIFF → **MP3, M4A, FLAC, WAV, OGG, OPUS**.
Сохраняет теги и обложку, присылает трек с превью, ведёт статистику в SQLite.

- Node.js 22 + [grammY](https://grammy.dev), весь код в `bot.js`
- SQLite через встроенный модуль `node:sqlite`, без нативных зависимостей
- Минималистичное инлайн-меню, которое редактируется на месте, с цветными кнопками (`style`: `primary` / `success` / `danger`)
- Премиум-эмодзи в тексте (`<tg-emoji>`) и на кнопках (`icon_custom_emoji_id`)
- Эмодзи лиц бот при запуске берёт из пака [FaceEmoji](https://t.me/addemoji/FaceEmoji) через `getStickerSet`

## M4P и DRM

Треки Apple Music (`.m4p`) и старые покупки iTunes зашифрованы FairPlay DRM.
Бот находит такие файлы и вежливо отказывается их обрабатывать: снимать защиту он не умеет.
Покупки iTunes Store после 2009 года приходят в M4A без DRM, их бот конвертирует.

## Запуск

```bash
# заполни .env (BOT_TOKEN, ADMIN_IDS)
npm install
npm start
```

### Docker

`.env` не попадает в образ, переменные передаются при запуске:

```bash
docker build -t m4p-bot .
docker run -d --name m4p-bot --restart unless-stopped \
  --env-file .env \
  -v m4p-data:/app/data \
  m4p-bot
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BOT_TOKEN` | — | Токен от @BotFather |
| `ADMIN_IDS` | — | ID админов через запятую |
| `EMOJI_PACK` | `FaceEmoji` | Пак премиум-эмодзи для лиц |
| `DB_PATH` | `./data/bot.db` | Путь к SQLite |
| `MAX_CONCURRENT` | `2` | Сколько конвертаций идут параллельно |
| `MAX_FILE_MB` | `20` | Лимит размера входного файла |
| `FFMPEG_TIMEOUT_SEC` | `600` | Таймаут ffmpeg |
| `BOT_API_ROOT` | `https://api.telegram.org` | Свой [Bot API сервер](https://github.com/tdlib/telegram-bot-api) в режиме `--local` для файлов до 2 ГБ |

## Важно про премиум-эмодзи

Эмодзи на кнопках (`icon_custom_emoji_id`) и `<tg-emoji>` в сообщениях работают, только если у **владельца бота** есть Telegram Premium
или бот купил дополнительный username на Fragment. Без этого Telegram покажет обычные эмодзи-заглушки.

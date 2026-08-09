# Epic 5 — Эксплуатация на Mac через LaunchAgent

**Требования PRD:** `OPS-01`, `OPS-02`, `OPS-03`

**Зависимости:** [Epic 3](./03-draw-and-reroll.md), [Epic 4](./04-production-bot-identity-and-ux.md)

## 1. Цель

Сделать production-бота обычным пользовательским сервисом macOS: он автоматически запускается после входа Татьяны в систему, восстанавливается после аварийного завершения и управляется воспроизводимыми командами без ручного запуска терминала каждый день.

## 2. Пользовательский результат

- После входа пользователя в macOS бот запускается через `launchd`.
- Если процесс аварийно завершился, `launchd` повторно запускает его с ограничением частоты.
- Оператор может установить, запустить, остановить, перезапустить, проверить и удалить LaunchAgent понятными командами.
- Token не хранится в plist, Git или аргументах процесса.
- Production-база, конфигурация и логи отделены от smoke-данных репозитория.
- Сон или выключение Mac не теряет розыгрыш: существующий recovery Epic 3 обрабатывает наступивший дедлайн после следующего запуска.

## 3. Топология и пути

LaunchAgent работает в GUI-domain текущего пользователя без `sudo`.

| Назначение | Путь или значение |
|---|---|
| Label | `ru.strelchuk.giveaways-bot` |
| Plist | `~/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist` |
| Production env | `~/Library/Application Support/StrelchukGiveawaysBot/production.env` |
| SQLite | `~/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite` |
| stdout | `~/Library/Logs/StrelchukGiveawaysBot/stdout.log` |
| stderr | `~/Library/Logs/StrelchukGiveawaysBot/stderr.log` |

Plist содержит абсолютные `ProgramArguments`, `WorkingDirectory`, пути логов и `DOTENV_CONFIG_PATH` с несекретным абсолютным путём к production env. Он не содержит `BOT_TOKEN` или `TEAM_TELEGRAM_IDS`.

Основной процесс остаётся тем же `node dist/index.js`. Отдельный worker, webhook или второй runtime не создаются.

## 4. Контракт LaunchAgent

- Используется абсолютный путь к Node, который удовлетворяет контракту репозитория.
- `RunAtLoad` запускает job после bootstrap/login.
- `KeepAlive` перезапускает только неуспешно завершившийся job.
- `ThrottleInterval` ограничивает частоту restart loop при постоянной ошибке.
- `WorkingDirectory` указывает на корень checkout.
- `StandardOutPath` и `StandardErrorPath` указывают на отдельные файлы логов.
- Job устанавливается в `gui/<uid>` современными `launchctl bootstrap`/`bootout`; legacy `load`/`unload` не используются.

LaunchAgent существует только в пользовательской GUI-сессии. Он не гарантирует работу до login, во время сна, при выключенном Mac или без сети.

## 5. Операционный интерфейс

Один repo-owned CLI предоставляет подкоманды:

- `install` — выполняет preflight, создаёт каталоги, атомарно записывает plist и делает bootstrap;
- `start` — загружает существующий plist, если job остановлен;
- `stop` — делает bootout, сохраняя plist и данные;
- `restart` — bootout и новый bootstrap;
- `status` — использует exit status `launchctl print`, показывает label, ожидаемые пути и последние безопасные сведения без парсинга нестабильного формата вывода как API;
- `logs` — показывает пути и ограниченный tail stdout/stderr;
- `uninstall` — делает bootout и удаляет только plist.

`uninstall` не удаляет production env, SQLite или логи. Разрушительный `purge` не входит в эпик.

## 6. Preflight и установка

До записи plist и bootstrap команда проверяет:

1. macOS и наличие современных команд `launchctl`;
2. версии Node и pnpm против `engines`/`packageManager`;
3. чисто выполненную production-сборку;
4. наличие production env и права не шире `0600`;
5. обязательные `BOT_TOKEN`, `TEAM_TELEGRAM_IDS`, абсолютный `DATABASE_PATH` и безопасный `LOG_LEVEL`;
6. что `DATABASE_PATH` находится вне checkout и не совпадает со smoke-базой `.data/gift-bot.sqlite`;
7. read-only `getMe` и точный username `strelchuk_giveaways_bot`;
8. что label ещё не загружен при `install`.

Любая ошибка завершает preflight до изменения LaunchAgent. `install` не перезаписывает существующий plist и не перезапускает уже загруженный job неявно.

## 7. Жизненный цикл и обновление

Нормальная установка выполняется один раз после подготовки production env и сборки. Обновление приложения выполняется явно:

1. `stop`;
2. обновление checkout;
3. `pnpm install` только при изменившихся зависимостях;
4. `pnpm check`, который включает production build;
5. `start`;
6. `status` и проверка логов.

При `SIGTERM` существующий runtime останавливает polling, прекращает принимать updates, дожидается выполняющихся операций и закрывает SQLite. `bootout` используется как граница остановки, поэтому `KeepAlive` не запускает job обратно во время обслуживания.

## 8. Ошибки и восстановление

- Невалидная production-конфигурация блокирует установку; token не выводится.
- Отозванный token или постоянная startup-ошибка после установки видны по ненулевому exit и stderr; throttling ограничивает restart loop.
- Ошибка bootstrap оставляет plist на диске для диагностики, но не считается успешной установкой.
- Повторный `stop` или `uninstall` сообщает, что job уже отсутствует, и не затрагивает данные.
- Несуществующий checkout/Node после установки приводит к launchd-ошибке и требует повторной установки с актуальными абсолютными путями.
- После сна, потери сети или выключения восстановление бизнес-состояний выполняет существующий runtime. LaunchAgent не добавляет отдельную очередь и не меняет гарантии Epic 3.
- Два процесса с одним token не поддерживаются; операционный сценарий требует остановить ручной `pnpm dev`/`pnpm start` до bootstrap production-job.

## 9. Критерии приёмки

- Plist проходит `plutil -lint` и содержит только согласованные абсолютные пути и несекретные значения.
- `install` отказывается работать с отсутствующим env, широкими правами файла, smoke database path или неправильным bot username.
- После `install` `launchctl print gui/<uid>/ru.strelchuk.giveaways-bot` завершается успешно, а лог содержит `bot_started`.
- После `restart` существует один production-процесс, и SQLite открывается без второго writer.
- После аварийного завершения job автоматически перезапускается не чаще заданного throttling-интервала.
- `stop` приводит к штатному `bot_stopped` и оставляет plist, env, базу и логи.
- `uninstall` удаляет регистрацию и plist, но сохраняет env, базу и логи.
- Дедлайн, наступивший во время остановленного job, обрабатывается после следующего `start` существующим recovery.

## 10. Проверка

- Unit: рендер plist, XML escaping, абсолютные пути, отсутствие секретных env values, preflight и отказ до side effects.
- Integration без реального launchd: изолированный временный HOME, fake command runner и сценарии install/start/stop/restart/status/uninstall.
- Static: shell/CLI syntax, `plutil -lint` с временным plist, `pnpm check`.
- Ручной macOS smoke: bootstrap в `gui/<uid>`, `bot_started`, status, graceful restart, аварийный restart, stop и uninstall с проверкой сохранности данных.
- Ручной recovery smoke: остановить job до короткого дедлайна и подтвердить завершение розыгрыша после запуска.

Локальные unit/integration-тесты не доказывают регистрацию job в реальном GUI-domain. Успешный `launchctl print` не доказывает корректный Telegram-профиль или полный розыгрыш.

## 11. Не входит в эпик

- работа без пользовательского login или во время сна/выключения Mac;
- системный LaunchDaemon, root-доступ и установка для всех пользователей;
- VPS, Docker, webhook, облачный деплой и внешний process manager;
- автоматический `git pull`, автоматические миграции перед каждым стартом или самообновление;
- удаление production-конфигурации, базы и логов;
- offsite backup, log rotation, алертинг и удалённый мониторинг;
- изменение Telegram-профиля и текстов бота.

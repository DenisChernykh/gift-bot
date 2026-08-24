# План: медиа-публикации, участники и экран управления розыгрышем

> Этот документ — только план. Его добавление, проверка и публикация в Git не меняют runtime-код, схему SQLite, production `.env`, LaunchAgent или уже опубликованные сообщения.

**Цель:** расширить создание розыгрыша до текста с 0–6 фотографиями (внутренняя модель до 10), дать оператору выбор положения caption, сохранить Telegram custom emoji, добавить приватный постраничный список участников и собрать управление розыгрышем в понятную карточку.

**Архитектурное решение:** контент и медиа хранятся раздельно. Один снимок публикуется текущим одиночным сообщением; 2–6 снимков — Telegram-альбомом. Альбом не принимает `reply_markup`, поэтому его CTA «Участвовать» будет отдельным коротким соседним сообщением; первый элемент альбома остаётся каноническим caption для счётчика, результатов и отмены. Все Telegram message IDs одной доставки хранятся явно, а синхронизация знает, какой из них редактировать или удалить.

**Стек:** Node 24.18.1, TypeScript ESM, grammY 1.45.x, Drizzle ORM, `node:sqlite`, Vitest 4.

## Подтверждённые ограничения Telegram

- `show_caption_above_media` поддерживается для photo/video/animation caption и должен быть передан при отправке/редактировании соответствующего сообщения: [Bot API](https://core.telegram.org/bots/api#inputmediaphoto).
- `sendMediaGroup` отправляет альбом из **2–10** медиафайлов, но среди его параметров нет `reply_markup`: [Bot API](https://core.telegram.org/bots/api#sendmediagroup). Следовательно, один Telegram-альбом с inline-кнопкой «Участвовать» технически недоступен через Bot API.
- `MessageEntity` поддерживает `type: custom_emoji` и поле `custom_emoji_id`: [Bot API](https://core.telegram.org/bots/api#messageentity). Это позволяет передавать исходную entity без преобразования в обычный emoji.
- Видимость custom emoji, отправленных именно ботом в канал, должна быть подтверждена реальным smoke на production identity. Этот план не предполагает покупку Fragment username, смену username или изменение Premium-статуса без отдельного согласования.

## Зафиксированный UX-контракт

1. Оператор вводит текст условий как отдельный шаг мастера; форматирование и custom emoji в нём сохраняются как Telegram entities.
2. Затем он выбирает «Без фото» или отправляет одну фотографию / альбом. Интерфейс принимает до 6 фотографий, backend валидирует до 10 для будущего расширения.
3. Для медиа оператор выбирает «Фото сверху» или «Фото снизу».
   - Для одного фото это нативный `show_caption_above_media` у фото с caption.
   - Для альбома caption находится у первого элемента; значение `show_caption_above_media` передаётся согласованно для всех элементов группы.
4. Публикация без фото — одно text-сообщение с условиями, счётчиком и кнопкой.
5. Публикация с одним фото — одно photo-сообщение с caption, счётчиком и кнопкой.
6. Публикация с 2–6 фото — альбом, где первый элемент содержит канонический caption с условиями и счётчиком, плюс сразу следующее короткое CTA-сообщение с кнопкой «Участвовать». Caption визуально расположен по выбору оператора; CTA существует только из-за ограничения Bot API.
7. При росте счётчика редактируется канонический text/caption. При итогах или отмене обновляется он же, а CTA альбома удаляется. Медиа не переотправляются и не дублируются.
8. «Участники» доступны только allowlisted-команде и только в карточках, которые уже доступны этому оператору. В выдачу попадают display name, `@username` при наличии и время первой регистрации — без телефонов, raw token, реферальных секретов и внутренних SQLite ID.
9. Исходный выбор победителя остаётся автоматическим по дедлайну. В карточке не появляется ручная кнопка «Выбрать победителя» для `active`, чтобы не сломать уже утверждённую гарантию неизменяемого snapshot. Для `completed` остаётся перевыбор конкретного занятого места.

## Invariants и миграционная совместимость

- Старые текстовые и однофото-розыгрыши продолжают открываться, считаться, отменяться, завершаться и перевыбираться без переотправки сообщений.
- Существующий один `content_file_id` мигрируется в первую запись медиа только для черновиков; для уже опубликованных записей сохраняется существующий delivery как каноническое сообщение.
- Максимум в UI — 6, во всех серверных валидаторах и ограничениях БД — 10. Значения 7–10 не принимаются текущим wizard UX, но не требуют нового формата данных в будущем.
- Все offsets entities остаются UTF-16 offsets Telegram. Нельзя trim/normalise/parse text после получения entities; сервисные строки прибавляют только рассчитанный offset.
- Неизвестный исход отправки альбома или CTA не ретраится повторной публикацией. Он остаётся в существующем fail-closed `failed`/диагностическом пути до ручной сверки.
- Каждый callback остаётся actor-bound, state-bound и одноразовым там, где это требуется сегодня.

---

## Task 1: Уточнить контракты и покрыть чистую доменную модель

**Files:**

- Modify: `src/domain/giveaway-validation.ts`
- Modify: `src/domain/giveaway-rendering.ts`
- Modify: `src/application/ports/giveaway-creation-repository.ts`
- Modify: `tests/domain/giveaway-validation.test.ts`
- Modify: `tests/domain/giveaway-rendering.test.ts`

**Interfaces:**

- Заменить бинарный `text | photo` на совместимую модель `text + media[]`, где `media[]` состоит из photo file IDs, порядок стабилен, а `mediaPosition` равен `above | below` только при наличии медиа.
- Ввести именованные лимиты `MAXIMUM_WIZARD_PHOTO_COUNT = 6` и `MAXIMUM_STORED_PHOTO_COUNT = 10`.
- Сохранить единый renderer канонического текста/caption, чтобы лимит 4096 применялся к text, а 1024 — к публикации с медиа.

- [ ] Сначала написать RED-тесты: 0, 1, 6, 7, 10 и 11 фото; порядок file IDs; отсутствие layout для text-only; UTF-16 entities с `custom_emoji_id`; и лимиты итогового text/caption.
- [ ] Реализовать минимальные типы и validation без изменения логики draw/reroll.
- [ ] Явно проверить, что custom emoji entity передаётся как непрозрачный объект и её `custom_emoji_id` не теряется.
- [ ] Обновить renderer: одна и та же каноническая строка используется для text, single photo и caption первого элемента альбома; offset пользовательских entities рассчитывается от заголовка, а не поиском подстроки.

## Task 2: Миграция хранения контента и публикационных сообщений

**Files:**

- Modify: `src/database/schema.ts`
- Create: `drizzle/0010_<generated>.sql`
- Modify: `src/database/giveaway-creation-repository.ts`
- Modify: `src/database/post-synchronization-repository.ts`
- Modify: `src/database/draw-repository.ts`
- Modify: `tests/database/bootstrap.test.ts`
- Modify: `tests/application/draft-wizard-service.test.ts`
- Modify: `tests/database/draw-repository.test.ts`

**Storage contract:**

- Добавить `giveaway_media` (`id`, `giveaway_id`, `position`, `telegram_file_id`, `created_at`) с unique `(giveaway_id, position)` и constraint позиции 1–10 на прикладном уровне.
- Добавить к giveaway nullable `media_caption_position` (`above | below`); старые photo получают `below`, соответствующий нынешнему Telegram поведению.
- Развить single-message `publication_deliveries` в явные delivery parts: `canonical`, `album_media`, `cta`. Для каждого хранить `message_id`, позицию фото, optional `media_group_id`, состояние и порядок.
- Миграция заполняет `canonical` из уже сохранённого `message_id`. Никакая старая активная публикация не получает новый CTA или новый album part задним числом.
- `sync_tasks`, cancellation и result sync адресуются к каноническому сообщению; CTA является зависимой частью и при terminal state удаляется с идемпотентной обработкой `message not found`.

- [ ] Написать RED миграционные тесты для чистой БД, повторного `db:migrate` и populated fixtures до Epic 3.
- [ ] Проверить upgrade старого active text, active photo, completed photo и failed publication: schema/foreign-key/integrity проходят, сохранённый message ID остаётся каноническим.
- [ ] Сгенерировать migration стандартным `pnpm db:generate` только после проверки Node `24.18.1` и pnpm `11.15.1`; не редактировать generated SQL вручную.
- [ ] Реализовать repository reads/writes с детерминированным порядком media и delivery parts.

## Task 3: Надёжный media wizard и визуальный предпросмотр

**Files:**

- Modify: `src/application/draft-wizard-service.ts`
- Modify: `src/telegram/gift-bot-adapter.ts`
- Modify: `src/application/ports/callback-action-repository.ts` при необходимости нового actor-bound action
- Modify: `tests/application/draft-wizard-service.test.ts`
- Modify: `tests/telegram/gift-bot-adapter.test.ts`

**UX:**

1. Шаг `content`: принять только текст условий, включая Telegram entities.
2. Шаг `media`: показать кнопки «Без фото» и «Готово». До «Готово» сохранять каждое полученное фото в порядке update; album messages с одним `media_group_id` не переводят wizard после первой фотографии.
3. После первой фотографии кнопка «Готово» доступна; при шестой UI сообщает о достигнутом лимите. Седьмое фото отклоняется без порчи уже сохранённого черновика.
4. При одном или более фото показать кнопки «Фото сверху» / «Фото снизу». Затем открыть channels/preview как сейчас.
5. Предпросмотр должен передавать исходные `entities`/`caption_entities`, чтобы custom emoji выглядели так же, как в канале. Для альбома preview использует реальный album плюс неинтерактивный макет CTA.

- [ ] Написать RED adapter-тесты для text-only, одного фото, media group из 2/6 фото, повторного delivery/update, седьмого фото, `Готово` до фото и отмены черновика посередине загрузки.
- [ ] Отдельно покрыть caption/custom emoji только у первого сообщения Telegram-альбома и отсутствие потери entities в preview.
- [ ] Реализовать persist-first flow: перезапуск процесса до «Готово» не теряет уже принятые file IDs и не создаёт второй wizard.
- [ ] Проверить, что новый upload шаг не принимает документы, видео, forwarded album и photos от неallowlisted пользователей.

## Task 4: Gateway, публикация, откат и синхронизация альбомов

**Files:**

- Modify: `src/application/ports/telegram-gateway.ts`
- Modify: `src/infrastructure/grammy-telegram-gateway.ts`
- Modify: `src/application/giveaway-publication-service.ts`
- Modify: `src/application/giveaway-post-synchronization-service.ts`
- Modify: `src/application/giveaway-cancellation-service.ts`
- Modify: `src/application/ports/giveaway-lifecycle-repository.ts`
- Modify: `src/application/ports/post-synchronization-repository.ts`
- Modify: `tests/infrastructure/grammy-telegram-gateway.test.ts`
- Modify: `tests/application/publication-service.test.ts`
- Modify: `tests/application/post-synchronization-service.test.ts`
- Modify: `tests/application/recovery-cancellation-service.test.ts`

**Gateway contract:**

- `sendGiveawayMessage` становится publication operation, которая возвращает все известные message parts, а не один `messageId`.
- Для одного фото вызвать `sendPhoto` с `caption`, `caption_entities`, `show_caption_above_media` и inline keyboard.
- Для 2–10 фото вызвать `sendMediaGroup` с ordered `InputMediaPhoto[]`; caption/entities назначить только первому фото, `show_caption_above_media` передать согласованно. После успешной группы отправить отдельное text CTA с inline keyboard.
- Для обновления счётчика и результата редактировать caption первого сообщения альбома. Для terminal result/cancel удалять CTA после успешной фиксации состояния; ошибки удаления обрабатывать существующим durable sync механизмом.
- Для одной фотографии сохранить сегодняшнее поведение: один канонический message одновременно содержит caption и кнопку.

- [ ] Написать RED gateway-тесты на exact grammY calls: single photo above/below, два фото, шесть фото, caption/entities только первого media item, CTA только у альбома и отсутствие `reply_markup` в `sendMediaGroup`.
- [ ] Написать RED publication/recovery-тесты на second-step CTA failure, unknown album send, известный rollback всех album message IDs, restart после сохранения album но до CTA и отсутствие повторной отправки в uncertain состоянии.
- [ ] Реализовать отправку и persistence всех parts. Розыгрыш становится `active` только когда каждое требуемое сообщение каждой delivery сохранено как delivered.
- [ ] Написать RED sync/cancellation/result-тесты: count edit сохраняет custom entities, result edit удаляет CTA, cancellation удаляет кнопку/CTA, и один сбой канала не ломает остальные.
- [ ] Реализовать latest-wins synchronization и idempotent delete для album CTA.

## Task 5: Проверенный custom emoji support и production-capability spike

**Files:**

- Modify: `tests/application/draft-wizard-service.test.ts`
- Modify: `tests/infrastructure/grammy-telegram-gateway.test.ts`
- Modify: `tests/telegram/gift-bot-adapter.test.ts`
- Create: `docs/verification/2026-08-24-media-and-management.md`
- Modify: `README.md`

**Rules:**

- Не вводить собственный parser emoji, не заменять `custom_emoji` на Unicode fallback и не синтезировать `custom_emoji_id`.
- Сохранять ровно entities, которые Telegram прислал администратору, с копированием только объекта верхнего уровня и корректным offset shift при добавлении служебных строк.
- Предпросмотр, initial publication и participant-count edit обязаны посылать ту же entity, включая custom emoji ID.
- Итоговое сообщение розыгрыша закономерно заменяет исходный caption текстом результатов; custom emoji исходных условий в нём не сохраняются, потому что сам исходный текст больше не является публичным сообщением.

- [ ] Написать RED unit/integration tests с entity `{ type: 'custom_emoji', offset, length, custom_emoji_id }` для text, single photo и album caption; проверить JSON persistence и exact API payload.
- [ ] Выполнить отдельный реальный Telegram smoke на test channel с production bot identity: input → preview → single-photo publication → album publication → participant count edit. Зафиксировать, сохраняется ли custom emoji визуально в канале и в edit.
- [ ] Если Telegram отклоняет entity в канале, остановить rollout этой возможности fail closed и записать точный API error/возможное требование дополнительного username/Premium как внешний blocker. Не покупать Fragment asset и не менять identity в рамках implementation PR.
- [ ] Только после положительного smoke отметить поддержку каналов в README; до него писать «передача entities поддержана кодом, канал не подтверждён».

## Task 6: Приватный список участников и карточка управления

**Files:**

- Modify: `src/application/ports/giveaway-management-repository.ts`
- Modify: `src/application/giveaway-management-service.ts`
- Modify: `src/database/giveaway-creation-repository.ts` or create focused `src/database/giveaway-management-repository.ts`
- Modify: `src/telegram/gift-bot-adapter.ts`
- Modify: `src/telegram/gift-bot-copy.ts`
- Modify: `tests/telegram/gift-bot-adapter.test.ts`
- Create or modify: `tests/application/giveaway-management-service.test.ts`
- Create or modify: `tests/database/giveaway-management-repository.test.ts`

**Interfaces:**

- Добавить `listParticipants({ giveawayId, administratorTelegramId, cursor, limit })` со стабильной сортировкой `joined_at ASC, id ASC` и opaque cursor, лимитом 20.
- Authorize вызов тем же allowlist/ownership boundary, что и карточку `/giveaways`; callback не даёт перейти к чужому giveaway или подменить cursor.
- Возвращать `totalCount`, `items[]` (`displayName`, nullable `username`, `joinedAt`) и `nextCursor`. В UI дата показывается в `Asia/Yekaterinburg` с недвусмысленным форматом.
- Карточка содержит: название, статус, участников, количество призовых мест, состояние синхронизации. Для completed также показываются текущие заполненные/пустые места.

- [ ] Написать RED repository tests на zero/one/21+ participant, одинаковый `joined_at`, cursor без пропусков/дубликатов, null username, live display-name update и отсутствие чужих записей.
- [ ] Написать RED adapter tests на «👥 Участники», previous/next pagination, team-only visibility, actor binding и длину Telegram сообщения.
- [ ] Реализовать callback action и formatter. Не добавлять export, Telegram ID, raw join/referral tokens или список участников в публичный канал.
- [ ] Обновить `/giveaways`: `active` показывает «👥 Участники» и текущий статус; `completed` дополнительно показывает «🔄 Перевыбрать место N» и «История перевыборов». Ручной initial draw и неопределённое «Настройки» не добавлять в этот scope.

## Task 7: Сквозная верификация, документация и независимое ревью

**Files:**

- Modify: `docs/PRD.md`
- Modify: `docs/epics/01-giveaway-creation.md`
- Modify: `docs/epics/02-participants-and-referrals.md`
- Modify: `docs/epics/03-draw-and-reroll.md`
- Modify: `README.md`
- Create: `docs/verification/2026-08-24-media-and-management.md`

- [ ] Перед командами, изменяющими зависимости или generated artifacts, сверить `node --version` с `.node-version` и `pnpm --version` с `packageManager`/`engines`; не менять зависимости без необходимости.
- [ ] Выполнить focused suites, чистую и populated migration, повторный migrate, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, `pnpm check` и `git diff --check`.
- [ ] Реальный smoke минимум на двух публичных test channels: text, one photo above/below, album 2 and 6 photos, counter edit, cancellation, deadline result, one reroll, restart recovery и двухстраничный список участников. Не выполнять этот smoke на рабочем канале без отдельного разрешения.
- [ ] Записать отдельно local, SQLite-migration, real Telegram и production evidence. Успешные fake tests не считать доказательством custom emoji в канале.
- [ ] Провести независимый read-only review до трёх циклов, как принято для этого репозитория; после каждого fix wave повторять relevant gate и не выполнять четвёртый цикл без явного разрешения.

## Порядок реализации и контрольные точки

1. Tasks 1–2: domain/storage/migration. **Gate:** old database reopens cleanly; существующие active/completed публикации не меняют Telegram message IDs.
2. Task 3: wizard/preview. **Gate:** перезапуск в середине альбома не теряет медиа, 7-е фото не меняет draft.
3. Task 4: publication/sync/recovery. **Gate:** rollback/recovery охватывает album и CTA; ни одна ошибка не создаёт дубль в канале.
4. Task 5: custom emoji spike. **Gate:** реальное визуальное подтверждение в канале либо честно зафиксированный внешний blocker.
5. Task 6: participants/card. **Gate:** pagination private, stable and actor-bound; automatic draw semantics unchanged.
6. Task 7: full verification, docs, review.

## Out of scope

- Покупка или аренда Fragment username, перенос username, Premium subscription changes и другие внешние Telegram account actions.
- Видео, documents, mixed media, media editing/reordering после публикации, web/admin UI, CSV export и общая «Настройки» без отдельно согласованного набора редактируемых полей.
- Изменение механики eligibility, ticket/referral calculation, automatic deadline draw или публичное раскрытие истории перевыборов.
- Деплой, рестарт LaunchAgent, миграция production database или отправка сообщений в production channel. Это отдельные авторизуемые действия после implementation merge.

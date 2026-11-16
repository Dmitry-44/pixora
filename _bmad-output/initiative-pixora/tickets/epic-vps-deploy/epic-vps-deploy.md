---
type: epic
title: "Бот работает на VPS"
parent: initiative-pixora
covers: [R9]
sources: []
companions: []
after: [epic-text-to-image, epic-fault-tolerance]
refined: false
risk: medium
---

# Бот работает на VPS

## Description

Эпик переносит стек, который эпики 1 и 2 запускают локально, на один VPS вне РФ тем же compose-файлом. Когда он готов, ботом пользуются без локальной машины автора, а отказоустойчивость, показанная локально, работает и на сервере.

## Outcome

Друзья пользуются ботом, работающим на VPS круглосуточно: сигнал — критерий успеха брифа 2.

## Done when

- На VPS вне РФ `docker compose up` поднимает migrate, postgres, bot и worker; после перезагрузки сервера и падения процесса они поднимаются сами (R9).
- Секреты лежат только в `.env` на сервере, не в репозитории.
- С VPS доступны Polza API и CDN и Telegram Bot API; пользователь из белого списка получает изображение от бота на VPS.

## Boundaries

- Не входит: CI/CD и бэкапы БД — деплой вручную (Boundaries инициативы).
- Не входит: изменения кода и compose-файла сверх конфигурации среды — их владельцы `epic-text-to-image` и `epic-fault-tolerance`.
- Touch point: VPS-провайдер — аренда и настройка сервера; владелец — этот эпик.

## References

- parent — _bmad-output/initiative-pixora/initiative-pixora.md, Requirements R9; Constraints (Docker Compose, секреты)
- architecture — _bmad-output/initiative-pixora/architecture-pixora/architecture-pixora.md, AD-8, «Structural Seed», «Consistency Conventions» (Конфиг)

## Notes

- Open question: доступны ли Polza API и CDN с выбранного VPS вне РФ; решается в первой истории эпика (из инициативы).
- Waits on epic-text-to-image because: нужен compose-файл со всеми сервисами и конфиг только из env.
- Waits on epic-fault-tolerance because: на сервер переносится конфиг отказоустойчивости, проверенный локально.
- Decision: 2026-11-16 — эпик идёт последним по выбору пользователя.

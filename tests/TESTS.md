# Тесты админ-панели

`admin.test.js` открывает `src/renderer/admin.html` в headless-браузере с заглушками
Electron/node и проверяет, что настройки реально применяются к DOM, а не просто
сохраняются в localStorage.

## Запуск

```bash
npm i -D playwright
npx playwright install chromium
node tests/admin.test.js
```

Чтобы проверить другой файл или указать свой Chromium:

```bash
node tests/admin.test.js путь/к/admin.html
PW_CHROME=/путь/к/chrome node tests/admin.test.js
```

Код возврата `0` — всё прошло, `1` — есть падения.

## Что проверяется (31 проверка)

**Оформление** — для каждого значения проверяется и сохранение, и фактический эффект:

| Настройка | Что должно измениться |
|---|---|
| `setBg` | CSS-переменная `--appbg` |
| `setFont` | вычисленный `font-family` у `body` |
| `setScale` | `document.documentElement.style.zoom` |
| `setDensity` | класс `density-compact` / `density-spacious` на `body` |
| `setAnim` | класс `no-anim` на `body` |
| `setSidebarStart` | `ui.sidebarStart` в localStorage |
| `setAccent` | `--brand` и `--brand-soft` |

**Язык** — для `ru`, `en`, `uk`, `pl` проверяется атрибут `html[lang]`, запись в
`appLang` и то, что реальный элемент интерфейса сменил текст.

**Экспорт / импорт** — настройки выставляются, сериализуются, стираются и
восстанавливаются; проверяется, что фон, шрифт, масштаб, плотность, анимации и
язык вернулись.

**Сброс** — `resetUi()` не оставляет ключей `ui.*`.

## Если тест упал

В выводе у каждой проверки видно ожидаемое и фактическое значение, например:

```
✗ setDensity(compact)  → stored=compact bodyClass=(none)
```

означает, что значение сохранилось, но класс на `body` не появился — искать в
`setDensity()` в `admin.html`.

Ошибки страницы (`pageerror`) печатаются в конце — если функция упала, они
покажут причину.

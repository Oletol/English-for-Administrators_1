# Шаблон интерактивного курса: GitHub Pages + Firebase

Болванка курса с ролями «студент» / «преподаватель», группами, открытием юнитов в реальном
времени, автосохранением ответов, отложенной проверкой и аналитикой.
Устройство и логика безопасности — в [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Пошаговая настройка (≈ 30 минут)

### Шаг 1. Проект Firebase
1. Откройте <https://console.firebase.google.com> → **Create project** (Google Analytics можно выключить).
   Тариф по умолчанию — бесплатный **Spark**, его достаточно.
2. На главной странице проекта нажмите значок **`</>`** (Add app → Web), название любое,
   Firebase Hosting **не** включайте.
3. Скопируйте объект `firebaseConfig` и вставьте его в **`docs/js/firebase-config.js`**.
   Там же задайте `COURSE_TITLE`. Эти ключи не секретны — защищают данные правила Firestore.

### Шаг 2. Авторизация
1. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable** (только первый переключатель).
2. **Authentication → Templates** → язык шаблонов (значок карандаша внизу) → *Russian*:
   письма восстановления пароля придут на русском.
3. **Authentication → Settings → Authorized domains → Add domain** → `ВАШ_ЛОГИН.github.io`.

### Шаг 3. База данных
1. **Build → Firestore Database → Create database** → регион (например, `europe-west3`) →
   **Start in production mode**.
2. Вкладка **Rules** → удалите всё → вставьте содержимое файла **`firestore.rules`** → **Publish**.

### Шаг 4. Аккаунт преподавателя (роль назначается только здесь)
1. **Authentication → Users → Add user** → ваш email и пароль. Скопируйте **User UID**.
2. **Firestore → Data → Start collection** → Collection ID: `teachers` →
   Document ID: *вставьте UID* → поле `name` (string) = ваше имя → **Save**.

Чтобы добавить второго преподавателя — повторите шаг 4. Чтобы снять роль — удалите документ.

### Шаг 5. Публикация на GitHub Pages
1. Создайте репозиторий на GitHub и загрузите в него эту папку
   (папка `content-private/` в репозиторий **не попадёт** — она в `.gitignore`; не удаляйте эту строку).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch** →
   Branch: `main`, папка **`/docs`** → Save.
3. Через 1–2 минуты сайт будет доступен:
   - студентам: `https://ВАШ_ЛОГИН.github.io/РЕПОЗИТОРИЙ/`
   - преподавателю: `https://ВАШ_ЛОГИН.github.io/РЕПОЗИТОРИЙ/teacher.html`

### Шаг 6. Первый запуск
1. Откройте `teacher.html`, войдите.
2. В левой панели, раздел **Teaching tools** → **Groups & students** → создайте группу (например, «Public Administration 21», код `PA-21`).
3. **Course content** → выберите файл `content-private/course.json` → **Import**.
   В разделе **Units** откройте Unit 1 — увидите задания с ключами и заметку преподавателя.
4. В другом браузере (или в режиме инкогнито) откройте главную страницу → **Create account** →
   укажите код группы. Юнит закрыт.
5. В кабинете: **Access & results** → «Open» у Unit 1 → у студента разделы появятся без перезагрузки.
6. Ответьте на несколько заданий, закройте вкладку, откройте снова — ответы на месте. Нажмите «Submit this unit».
7. В кабинете: **Student work** → «Open» → оцените открытый ответ → «Save marks».
8. **Access & results** → «Check & release» → студент сразу видит результат, ошибки и комментарий.
9. **Analytics** — самые трудные вопросы, частые ошибки, тепловая карта.

### Шаг 7. Проверка безопасности (рекомендуется)
- **Автоматически:** при каждом `push` GitHub Actions запускает `tests/rules.test.mjs`
  в эмуляторе Firestore (вкладка **Actions** в репозитории; зелёная галочка = правила работают).
- **Вручную:** войдите студентом, откройте инструменты разработчика (F12 → Network) и убедитесь,
  что ни один ответ сервера не содержит ключей; прямая ссылка на `teacher.html` покажет
  «Нет прав преподавателя».
- **До старта занятий** проверьте вход и сохранение из тех сетей, где будут работать студенты
  (вуз, мобильный интернет): доступность сервисов Google может различаться.

---

## Формат контента (JSON)

Курс готовится как JSON-файл, который хранится у вас (не в репозитории) и загружается через
«Course content → Import». Ключи (`answer`) пишутся прямо в заданиях — при импорте они
автоматически вырезаются и сохраняются отдельно.

```jsonc
{
  "units": [
    {
      "id": "u1", "order": 1, "title": "Unit 1 · Model of Communication",
      "sections": [
        { "id": "grammar", "title": "4. Grammar in Use", "blocks": [

          { "type": "html", "html": "<div class='rule'><b>Rule.</b> …</div>" },

          { "type": "teacher-note", "html": "<p>Видно только преподавателю</p>" },

          { "type": "exercise", "id": "g1", "kind": "gap", "title": "Exercise 1",
            "rubric": "Put the verb into the correct form.",
            "items": [
              { "id": "1", "text": "The department ___ (send) newsletters.", "answer": "sends" },
              { "id": "2", "text": "I ___ (not understand) why…", "answer": ["don't understand", "do not understand"] }
            ] },

          { "type": "exercise", "id": "v1", "kind": "match", "title": "Collocations",
            "options": [ { "id": "a", "text": "an effort" }, { "id": "b", "text": "difficulty" } ],
            "items": [ { "id": "1", "text": "make", "answer": "a" } ] },

          { "type": "exercise", "id": "r3", "kind": "mcq", "title": "Comprehension",
            "items": [ { "id": "1", "text": "Feedback is…", "options": ["the process…", "information…"], "answer": "B" } ] },

          { "type": "exercise", "id": "w2", "kind": "open", "title": "Write a paragraph",
            "items": [ { "id": "1", "text": "Your paragraph:", "max": 10, "rows": 7 } ] }
        ] }
      ]
    },
    { "id": "u2", "order": 2, "title": "Unit 2 · …", "status": "soon" }
  ]
}
```

| kind | Что видит студент | `answer` |
|---|---|---|
| `gap` | поле ввода на месте `___` (`size` — ширина) | строка или массив допустимых вариантов |
| `match` | выпадающий список из `options` (`"showOptionList": false` скрывает строку вариантов) | `id` варианта |
| `mcq` | радиокнопки A, B, C… из `options` пункта | буква |
| `open` | многострочное поле, оценивается вручную (`max` — макс. балл, по умолчанию 5) | — |

Правила: `id` юнитов — латиница/цифры/`-`/`_`; `id` упражнений уникальны в юните;
`id` пунктов уникальны в упражнении. Повторный импорт юнита с тем же `id` заменяет контент,
ответы студентов сохраняются (если не менять `id` упражнений и пунктов).
В `html`-блоках можно использовать классы исходного курса: `lead`, `rule`, `panel`, `disc`,
таблицы, `<iframe>` для видео, `<audio>`.

---

## Локальная разработка

```bash
npm run serve          # http://localhost:5055 — работает с «боевым» Firebase из конфига
npm install
npm run test:rules     # тесты правил в эмуляторе (нужна Java 21)
```

Чтобы работать с эмуляторами вместо боевой базы: `npx firebase emulators:start --project demo-course`
и откройте `http://localhost:5055/?emu`.

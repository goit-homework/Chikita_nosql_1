# Chikita_nosql_1: аналітика треків Spotify у MongoDB

Завдання 1 курсу «NoSQL та векторні бази даних»: завантажую [Spotify Tracks Dataset](https://www.kaggle.com/datasets/maharshipandya/-spotify-tracks-dataset) у MongoDB, перетворюю на документну схему через Aggregation Pipeline, пишу аналітичні запити й аналізую індекси через `explain()`.

## Налаштування оточення

Потрібні Python 3.11 або новіший (`pandas==3.0.3` не ставиться на старіші версії), [`mongosh`](https://www.mongodb.com/try/download/shell) 2.x і MongoDB 8.0: кластер Atlas M0 або локальний контейнер.

```bash
python3 -m venv .venv          # python3 має бути 3.11+, інакше вкажіть, наприклад, python3.12
source .venv/bin/activate
pip install -r requirements.txt
```

Датасет з Kaggle (потрібен `~/.kaggle/kaggle.json`) розпаковується в корінь репозиторію як `dataset.csv`:

```bash
kaggle datasets download -d maharshipandya/-spotify-tracks-dataset --unzip
```

Рядок підключення лежить у `.env`, якого в git немає. Створіть його з `.env.example` і вставте свій рядок з Atlas (Connect → Drivers), замінивши `<db_password>` на пароль користувача бази. Символи `$ : / ? # [ ] @` у паролі треба закодувати (`@` як `%40`).

```
MONGO_URI='mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority'
```

Одинарні лапки обов'язкові: без них shell під час `source .env` сприйме `&` як кінець команди, `MONGO_URI` лишиться порожнім, і `mongosh` мовчки підключиться до localhost.

Без Atlas підійде локальний MongoDB 8.0 у Docker, тоді в `.env` пишемо `MONGO_URI='mongodb://localhost:27017/'`:

```bash
docker run -d --name spotify-mongo -p 27017:27017 mongo:8.0
```

`mongosh` сам `.env` не читає, тому змінну спершу експортуємо в shell. Порядок запуску:

```bash
set -a; source .env; set +a
python scripts/01_load_data.py
mongosh "$MONGO_URI" --file scripts/02_transform.js
mongosh "$MONGO_URI" --file queries/part2_queries.js
mongosh "$MONGO_URI" --file queries/part3_indexes.js
mongosh "$MONGO_URI" --file queries/data_checks.js
```

Останній скрипт умова не вимагає: ним я перевіряв факти про дані, на які посилаюся нижче ([`outputs/data_checks.txt`](outputs/data_checks.txt)).

Усі виводи в [`outputs/`](outputs/) отримано на Atlas M0 (MongoDB 8.0.39, AWS Frankfurt). Перед тим я проганяв ті самі скрипти в Docker, і результати збіглися, крім `_id` і часу виконання. Ліміт M0 на сортування в пам'яті (32 МБ) наші запити не зачіпають: найбільше сортування займає 6.4 МБ.

Так виглядає Atlas після запуску всіх скриптів:

![Cluster0 в Atlas: MongoDB 8.0.39, AWS Frankfurt, тир Free](screenshots/atlas_cluster.png)

![Data Explorer: spotify.tracks, 113 999 документів](screenshots/atlas_tracks.png)

## Дані і схема колекції `tracks`

`01_load_data.py` прочитав 114 000 рядків і відкинув один, де немає ні виконавця, ні назви треку. У `tracks_raw` і `tracks` вийшло по 113 999 документів. Документ після `02_transform.js`:

```json
{
  "_id": { "$oid": "6b030a05c4be42ad60a43ba4" },
  "track_id": "5SuOikwiRyPMVoIQDJUgSV",
  "album_name": "Comedy",
  "track_name": "Comedy",
  "popularity": 73,
  "duration_ms": 230666,
  "explicit": false,
  "track_genre": "acoustic",
  "artists": ["Gen Hoshino"],
  "audio_features": {
    "danceability": 0.676,
    "energy": 0.461,
    "loudness": -6.746,
    "speechiness": 0.143,
    "acousticness": 0.0322,
    "instrumentalness": 0.00000101,
    "liveness": 0.358,
    "valence": 0.715,
    "tempo": 87.917,
    "key": 1,
    "mode": 0,
    "time_signature": 4
  },
  "duration_sec": 230.7,
  "popularity_tier": "high"
}
```

Рядок виконавців став масивом `artists` (розбитий за `;` і очищений `$trim`), а 12 аудіохарактеристик зібрано в об'єкт `audio_features`. Обчислювані поля: `duration_sec` і `popularity_tier` (`high` від 70, `medium` від 40, решта `low`).

Для частини 2 важливо, що датасет зібрано за жанрами: 114 жанрів по 1 000 рядків. Тому той самий трек часто стоїть у кількох жанрах, і різних `track_id` лише 89 740.

## Частина 1: відповіді на питання

**1. Чому аудіохарактеристики винесено в `audio_features`.** Ці 12 полів описують звук, і саме з ними працюють запити на кшталт «вечірки» чи «музики для роботи». Вкладений об'єкт ділить документ на метадані треку і звук. Усі характеристики беруться однією проєкцією `{ audio_features: 1 }`, а нова додається всередину, не розширюючи верхній рівень. Вкладення вигідне, коли полів небагато, вони пов'язані за змістом, читаються разом і належать лише цьому треку. Проблеми починаються, коли об'єкт росте без меж (історія прослуховувань у треку вперлася б у ліміт документа 16 МБ) або ті самі дані треба оновлювати в багатьох документах. Ще шляхи довшають: у фільтрах та індексах пишу `"audio_features.danceability"`.

**2. Чому виконавці зберігаються масивом.** Кількох виконавців мають 30 075 документів, а рядок на кшталт `"Rema;Selena Gomez"` для бази лише текст. Артиста в ньому можна знайти тільки регулярним виразом, і без `^` на початку такий пошук не звужує межі індексу, тобто повільний. Ще й неточний: «Drake» зачепив би Nick Drake (12 документів) і Ashley Drake (4), тоді як `{ artists: "Drake" }` повертає лише 50 документів самого Drake. З масивом простішими стають такі запити:

- спільні треки двох артистів: `{ artists: { $all: ["Drake", "Future"] } }`;
- пошук за головним виконавцем: `{ "artists.0": "Drake" }`;
- кількість виконавців: `$size`;
- статистика по кожному артисту через `$unwind` (завдання 2.2).

Індекс на `artists` при цьому стає multikey, з окремим ключем на кожного артиста.

## Частина 2: запити

Код у [`queries/part2_queries.js`](queries/part2_queries.js), повний вивід у [`outputs/part2_queries.txt`](outputs/part2_queries.txt). Оскільки трек буває в кількох жанрах, у таблицях результатів я групую документи за `track_id` (`$group` + `$addToSet`) і показую всі жанри треку. `$lookup` не знадобився: усі дані лежать в одній колекції.

### Завдання 1. Треки для вечірки

```js
db.tracks.find(
  {
    "audio_features.danceability": { $gt: 0.7 },
    "audio_features.energy": { $gt: 0.7 },
    duration_ms: { $gte: 180000, $lte: 300000 }
  },
  { _id: 0, track_name: 1, artists: 1, track_genre: 1, popularity: 1, duration_sec: 1,
    "audio_features.danceability": 1, "audio_features.energy": 1 }
).sort({ popularity: -1, track_id: 1, track_genre: 1, _id: 1 });
```

Умови на вкладені поля пишуться через крапку, межі тривалості включні: 180 000 і 300 000 мс. Сортую за популярністю, а додаткові ключі тримають порядок однаковим між запусками. `_id` стоїть останнім, бо через однакові рядки CSV навіть пара `track_id` і `track_genre` не унікальна.

Результат: 7 311 документів, з них 5 328 різних треків. Перші п'ять:

| popularity | track_name | artists | genres |
|---|---|---|---|
| 92 | Calm Down (with Selena Gomez) | Rema, Selena Gomez | pop |
| 91 | LOKERA | Rauw Alejandro, Lyanno, Brray | latin, latino |
| 90 | Party | Bad Bunny, Rauw Alejandro | latino, reggae, reggaeton |
| 89 | About Damn Time | Lizzo | hip-hop |
| 89 | LA INOCENTE | Mora, Feid | latino |

### Завдання 2. Виконавці, у яких усі треки популярні

```js
db.tracks.aggregate([
  { $unwind: "$artists" },
  { $group: { _id: { artist: "$artists", track_id: "$track_id" }, popularity: { $max: "$popularity" } } },
  { $group: { _id: "$_id.artist", track_count: { $sum: 1 },
              min_popularity: { $min: "$popularity" }, avg_popularity: { $avg: "$popularity" } } },
  { $match: { track_count: { $gte: 3 }, min_popularity: { $gte: 60 } } },
  { $sort: { avg_popularity: -1, track_count: -1, _id: 1 } },
  { $limit: 20 },
  { $project: { _id: 0, artist: "$_id", track_count: 1,
                min_popularity: { $round: ["$min_popularity", 1] },
                avg_popularity: { $round: ["$avg_popularity", 1] } } }
]);
```

`$unwind` розгортає масив, тож «Calm Down» зараховується і Rema, і Selena Gomez. Перший `$group` за парою (артист, `track_id`) рахує кожен трек артиста один раз, навіть якщо він є в п'яти жанрах. Другий `$group` рахує для артиста кількість треків, мінімум і середнє. `$match` лишає тих, у кого щонайменше три треки і найменша популярність не нижча за 60: шкала 0-100, тож «60% або вище» означає `>= 60`. Топ-20 беру за середньою популярністю.

Умову проходять 170 артистів, а без дедуплікації їх було б 334: майже половина мала б лише один-два треки, продубльовані в жанрах. Якщо популярність треку різна в різних жанрах, беру максимум. Перевірив і мінімум: склад і топ-20 ті самі. Треком я вважаю `track_id`, як і датасет, тож у Harry Styles «As It Was» із синглу й з альбому рахується двічі.

| artist | track_count | min_popularity | avg_popularity |
|---|---|---|---|
| Harry Styles | 3 | 89 | 92 |
| Olivia Rodrigo | 5 | 86 | 87.4 |
| IVE | 3 | 79 | 84 |
| Morgan Wallen | 3 | 81 | 83.3 |
| One Direction | 5 | 80 | 83 |
| Lil Nas X | 8 | 77 | 82.8 |
| Måneskin | 5 | 76 | 82.6 |
| TV Girl | 3 | 80 | 81.7 |
| Mora | 6 | 69 | 80.3 |
| Luke Combs | 3 | 79 | 80.3 |
| Maroon 5 | 3 | 70 | 79.7 |
| Mitski | 6 | 75 | 78.3 |
| Mark Ronson | 3 | 74 | 78.3 |
| LE SSERAFIM | 4 | 75 | 78 |
| Beach Bunny | 3 | 73 | 78 |
| Shubh | 5 | 69 | 77.8 |
| SZA | 4 | 65 | 77.8 |
| Jhay Cortez | 3 | 75 | 77.7 |
| Mother Mother | 3 | 76 | 77.3 |
| Tiago PZK | 4 | 72 | 77 |

### Завдання 3. Нетипові треки

```js
db.tracks.aggregate([
  { $group: {
      _id: "$track_genre",
      avg_tempo: { $avg: "$audio_features.tempo" },
      std_tempo: { $stdDevPop: "$audio_features.tempo" },
      tracks: { $push: { _id: "$_id", track_name: "$track_name", popularity: "$popularity",
                         artists: "$artists", tempo: "$audio_features.tempo" } }
  } },
  { $addFields: { threshold: { $add: ["$avg_tempo", { $multiply: [2, "$std_tempo"] }] } } },
  { $project: {
      _id: 0,
      avg_tempo: { $round: ["$avg_tempo", 1] },
      genre: "$_id",
      outlier_threshold: { $round: ["$threshold", 1] },
      outlier_tracks: { $map: {
        input: { $sortArray: {
          input: { $filter: { input: "$tracks", as: "t", cond: { $gt: ["$$t.tempo", "$threshold"] } } },
          sortBy: { tempo: -1 } } },
        as: "t",
        in: { _id: "$$t._id", track_name: "$$t.track_name", popularity: "$$t.popularity",
              artists: "$$t.artists", audio_features: { tempo: "$$t.tempo" } } } }
  } },
  { $sort: { genre: 1 } }
]);
```

`$group` рахує для кожного жанру `$avg` і `$stdDevPop` темпу й одночасно складає треки жанру в масив, а `$addFields` додає поріг: середнє плюс два стандартні відхилення. `$filter` лишає треки, швидші за поріг, `$sortArray` ставить найшвидші першими, а `$map` приводить кожен трек до формату з умови. Порівнюю з неокругленим порогом, до 0.1 округлюю лише вивід. Жанри без нетипових треків лишаються в результаті з порожнім масивом.

Для acoustic вийшли ті самі `avg_tempo` 119 і `outlier_threshold` 178.5, що й у прикладі з умови. «The Legend of Olog-hai, Pt. 1» з темпом 182.379 теж є серед 34 нетипових треків жанру. Початок документа:

```js
{
  avg_tempo: 119,
  genre: 'acoustic',
  outlier_threshold: 178.5,
  outlier_tracks: [
    { _id: ObjectId('6b030a05c4be42ad60a43d24'), track_name: 'Fast Car', popularity: 61,
      artists: ['Boyce Avenue', 'Kina Grannis'], audio_features: { tempo: 204.961 } },
    { _id: ObjectId('6b030a05c4be42ad60a43dab'), track_name: 'Running Up That Hill (A Deal With God) - Acoustic',
      popularity: 51, artists: ['Jonah Baker'], audio_features: { tempo: 203.816 } },
    ...
  ]
}
```

Усього 3 506 нетипових записів (2 925 різних треків) у 112 жанрах із 114. Лише drum-and-bass і happy не мають жодного: їхній поріг вищий за найшвидший трек жанру. У drum-and-bass відхилення, схоже, роздувають треки з помилково визначеним половинним темпом: поріг 218.4 при максимумі 184.0. Жанри з найбільшою кількістю нетипових треків:

| genre | avg_tempo | outlier_threshold | outliers | fastest |
|---|---|---|---|---|
| dancehall | 112.9 | 171.4 | 81 | 219.571 |
| opera | 105.6 | 167.3 | 65 | 201.832 |
| electro | 120.8 | 175.7 | 62 | 203.968 |
| j-dance | 114.9 | 175.1 | 62 | 212.276 |
| edm | 122 | 166.6 | 58 | 213.928 |

### Завдання 4. Треки для фонової роботи

```js
db.tracks.find(
  {
    "audio_features.loudness": { $lt: -10 },
    "audio_features.speechiness": { $lt: 0.1 },
    "audio_features.instrumentalness": { $gt: 0.5 },
    explicit: false
  },
  { _id: 0, track_name: 1, artists: 1, track_genre: 1, popularity: 1,
    "audio_features.loudness": 1, "audio_features.speechiness": 1, "audio_features.instrumentalness": 1 }
).sort({ popularity: -1, track_id: 1, track_genre: 1, _id: 1 });
```

Чотири умови з'єднуються неявним AND. Поле `explicit` після `01_load_data.py` булеве, тож вистачає точного збігу з `false`. Результат: 9 324 документи, з них 8 311 різних треків. Перші п'ять:

| popularity | track_name | artists | genres |
|---|---|---|---|
| 86 | everything i wanted | Billie Eilish | electro |
| 85 | Clean White Noise - Loopable with no fade | White Noise Baby Sleep, White Noise for Babies | sleep |
| 79 | Show Me How | Men I Trust | indie, indie-pop |
| 79 | Experience | Ludovico Einaudi, Daniel Hope, I Virtuosi Italiani | ambient, classical |
| 78 | K. | Cigarettes After Sex | ambient, indie, indie-pop |

«everything i wanted» Billie Eilish на першому місці має вокал, але фільтр проходить. Трек тихий (loudness -14.5), а `instrumentalness`, тобто ймовірність, що вокалу немає, модель Spotify оцінила в 0.657.

## Частина 3: індекси та оптимізація

Код у [`queries/part3_indexes.js`](queries/part3_indexes.js), вивід у [`outputs/part3_indexes.txt`](outputs/part3_indexes.txt). Скрипт спершу видаляє всі індекси, крім `_id`, тож його можна запускати повторно. На кожен запит він друкує стадії виграшного плану і ключові поля `explain("executionStats")`.

### Завдання 1. Аналіз запиту та індексація

Запит: `track_genre: "pop"`, `audio_features.danceability >= 0.7`, сортування `popularity: -1`.

| | Без індексу | Індекс ESR | Для порівняння: індекс E-R-S |
|---|---|---|---|
| індекс | немає | `{ track_genre: 1, popularity: -1, "audio_features.danceability": 1 }` | `{ track_genre: 1, "audio_features.danceability": 1, popularity: -1 }` |
| план | `SORT <- COLLSCAN` | `FETCH <- IXSCAN` | `FETCH <- SORT <- IXSCAN` |
| сортування в пам'яті | так | ні | так |
| nReturned | 354 | 354 | 354 |
| totalKeysExamined | 0 | 412 | 354 |
| totalDocsExamined | 113 999 | 354 | 354 |
| seeks (стрибки IXSCAN) | - | 58 | 1 |
| executionTimeMillis | 87 | 2 | 2 |

**Що змінилося в плані.** Без індексу MongoDB читає всю колекцію (`COLLSCAN`, 113 999 документів заради 354), а потім сортує результат у пам'яті. Індекс я створив за правилом ESR: спершу точний збіг `track_genre`, потім `popularity` у напрямку сортування, наприкінці діапазон `danceability`. Тепер план `FETCH <- IXSCAN`: сканування обмежене жанром pop, danceability перевіряється прямо в індексі, і з колекції читаються лише 354 документи. `SORT` зник, бо ключі вже йдуть у порядку `popularity: -1`.

Для порівняння скрипт через `hint()` пробує порядок «збіг, діапазон, сортування»: ключів менше (354 проти 412, без 58 стрибків IXSCAN між значеннями популярності), але сортувати доводиться в пам'яті. На великій вибірці блокувальний `SORT` з лімітом пам'яті коштує дорожче, тому я лишив ESR.

**Як зрозуміти, що індекс використовується.** У `winningPlan` замість `COLLSCAN` стоїть `IXSCAN` з `indexName: "genre_popularity_danceability"`, а стадії `SORT` немає. `indexBounds` показує межі сканування, `totalKeysExamined` зріс з 0 до 412, а `totalDocsExamined` упав зі 113 999 до 354, тобто до кількості повернених документів. Зведення після створення індексу (`planStages` і `seeks` скрипт збирає зі стадій плану, решта полів з `explain()` без змін):

```js
{
  planStages: 'FETCH <- IXSCAN(genre_popularity_danceability)',
  nReturned: 354,
  totalKeysExamined: 412,
  totalDocsExamined: 354,
  executionTimeMillis: 2,
  rejectedPlans: 0,
  seeks: 58,
  indexBounds: {
    track_genre: [ '["pop", "pop"]' ],
    popularity: [ '[MaxKey, MinKey]' ],
    'audio_features.danceability': [ '[0.7, inf.0]' ]
  }
}
```

### Завдання 2. Індекс для інших полів

Запит: `explicit: false`, `instrumentalness > 0.5`, `speechiness < 0.1`. Індекс `{ explicit: 1, "audio_features.instrumentalness": 1, "audio_features.speechiness": 1 }`.

| | Без індексу | З індексом | Для порівняння: speechiness перед instrumentalness |
|---|---|---|---|
| план | `COLLSCAN` | `FETCH <- IXSCAN` | `FETCH <- IXSCAN` |
| nReturned | 16 141 | 16 141 | 16 141 |
| totalKeysExamined | 0 | 16 602 | 16 921 |
| totalDocsExamined | 113 999 | 16 141 | 16 141 |
| seeks (стрибки IXSCAN) | - | 461 | 780 |
| executionTimeMillis | 137 | 39 | 44 |

**Що змінилося в плані.** Без індексу знову `COLLSCAN` по 113 999 документах. З індексом план став `FETCH <- IXSCAN(explicit_instrumentalness_speechiness)` з межами на всіх трьох полях: `explicit: [false, false]`, `instrumentalness: (0.5, inf.0]`, `speechiness: [-inf.0, 0.1)`. Документів читається рівно стільки, скільки повертається: 16 141.

**Чому такий порядок полів.** `explicit` перевіряється точним збігом, тому стоїть першим. З двох діапазонів першим іде instrumentalness, бо в межах у нього менше різних значень: 500 проти 779 у speechiness. IXSCAN перестрибує до діапазону третього поля приблизно раз на кожне таке значення. У зворотному порядку стрибків 780 замість 461, а ключів 16 921 замість 16 602.

### Завдання 3. Покривний запит

Запит `db.tracks.find({ track_genre: "pop", popularity: { $gte: 70 } })` не є покривним.

| | Без проєкції | З проєкцією `{ _id: 0, track_genre: 1, popularity: 1 }` |
|---|---|---|
| план | `FETCH <- IXSCAN` | `PROJECTION_COVERED <- IXSCAN` |
| totalKeysExamined | 317 | 317 |
| totalDocsExamined | 317 | 0 |

Індекс із завдання 1 запит використовує добре: межі `track_genre: ["pop", "pop"]` і `popularity: [inf.0, 70]` беруть рівно 317 потрібних ключів. Але проєкції немає, тож запит має повернути цілі документи з `track_name`, `artists`, `audio_features` та рештою полів, а в індексі лише три поля. Тому в плані є `FETCH`, і з колекції читаються 317 документів. Покривним запит стає, коли і фільтр, і проєкція використовують тільки поля індексу. `_id` треба прибрати явно: його в індексі немає, а MongoDB повертає його за замовчуванням. З такою проєкцією (права колонка) документи не читаються взагалі.

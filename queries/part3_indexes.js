// queries/part3_indexes.js
// Запуск: mongosh "ВАШ_URI" --file queries/part3_indexes.js
// Скрипт ідемпотентний: на початку видаляє всі індекси tracks, крім _id.

db = db.getSiblingDB("spotify");

// Стадії виграшного плану від кореня до листа, з назвою індексу для IXSCAN
function stages(explain) {
  const plan = explain.queryPlanner.winningPlan.queryPlan || explain.queryPlanner.winningPlan;
  const out = [];
  for (let p = plan; p; p = p.inputStage || (p.inputStages && p.inputStages[0])) {
    out.push(p.stage + (p.indexName ? `(${p.indexName})` : ""));
  }
  return out;
}

function findStage(explain, name) {
  const plan = explain.queryPlanner.winningPlan.queryPlan || explain.queryPlanner.winningPlan;
  for (let p = plan; p; p = p.inputStage || (p.inputStages && p.inputStages[0])) {
    if (p.stage === name) return p;
  }
  return null;
}

// Те саме для дерева executionStats: тут IXSCAN має лічильники виконання, зокрема seeks
function findExecStage(stage, name) {
  for (let s = stage; s; s = s.inputStage || (s.inputStages && s.inputStages[0])) {
    if (s.stage === name) return s;
  }
  return null;
}

// Зведення explain("executionStats") для порівняння до і після індексу.
// planStages - стадії winningPlan від кореня до листа, зібрані в рядок; решта полів узяті з explain без змін.
// seeks - скільки разів IXSCAN перестрибував від одного діапазону ключів до наступного.
function summary(label, explain) {
  const es = explain.executionStats;
  const ixscan = findStage(explain, "IXSCAN");
  const ixscanExec = findExecStage(es.executionStages, "IXSCAN");
  print(`\n--- ${label} ---`);
  printjson({
    planStages: stages(explain).join(" <- "),
    nReturned: es.nReturned,
    totalKeysExamined: es.totalKeysExamined,
    totalDocsExamined: es.totalDocsExamined,
    executionTimeMillis: es.executionTimeMillis,
    rejectedPlans: explain.queryPlanner.rejectedPlans.length,
    ...(ixscanExec ? { seeks: ixscanExec.seeks } : {}),
    ...(ixscan ? { indexBounds: ixscan.indexBounds } : {})
  });
}

db.tracks.dropIndexes();


// ============================================================
// Завдання 1. Аналіз запиту та індексація
// ============================================================
print("\n=== Завдання 1. Аналіз запиту та індексація ===");

const popQuery = { track_genre: "pop", "audio_features.danceability": { $gte: 0.7 } };
const popSort = { popularity: -1 };

summary("До індексу", db.tracks.find(popQuery).sort(popSort).explain("executionStats"));

// Правило ESR: спершу поле точного збігу (track_genre), потім поле сортування
// (popularity, у тому ж напрямку, що й sort), і лише потім діапазон (danceability).
db.tracks.createIndex(
  { track_genre: 1, popularity: -1, "audio_features.danceability": 1 },
  { name: "genre_popularity_danceability" }
);

summary("Після індексу { track_genre: 1, popularity: -1, audio_features.danceability: 1 }",
        db.tracks.find(popQuery).sort(popSort).explain("executionStats"));

// Для порівняння: порядок "точний збіг, діапазон, сортування".
// Ключів читається менше (діапазон суцільний, без стрибків), але сортувати доводиться в пам'яті.
db.tracks.createIndex(
  { track_genre: 1, "audio_features.danceability": 1, popularity: -1 },
  { name: "genre_danceability_popularity" }
);
summary("Порівняння: індекс { track_genre: 1, audio_features.danceability: 1, popularity: -1 } через hint",
        db.tracks.find(popQuery).sort(popSort).hint("genre_danceability_popularity").explain("executionStats"));
db.tracks.dropIndex("genre_danceability_popularity");


// ============================================================
// Завдання 2. Індекс для інших полів
// ============================================================
print("\n=== Завдання 2. Індекс для інших полів ===");

const workQuery = {
  explicit: false,
  "audio_features.instrumentalness": { $gt: 0.5 },
  "audio_features.speechiness": { $lt: 0.1 }
};

print("Документів з instrumentalness > 0.5:", db.tracks.countDocuments({ "audio_features.instrumentalness": { $gt: 0.5 } }));
print("Документів зі speechiness < 0.1:", db.tracks.countDocuments({ "audio_features.speechiness": { $lt: 0.1 } }));
for (const [field, range] of [["audio_features.instrumentalness", { $gt: 0.5 }], ["audio_features.speechiness", { $lt: 0.1 }]]) {
  const inBounds = { explicit: false, [field]: range };
  print(`explicit: false і ${field} у межах: документів ${db.tracks.countDocuments(inBounds)}, різних значень ${db.tracks.distinct(field, inBounds).length}`);
}

summary("До індексу", db.tracks.find(workQuery).explain("executionStats"));

// explicit - точний збіг, тому першим. Межі ставляться на обидва діапазони, але для кожного
// значення першого діапазону IXSCAN перестрибує (seek) до початку другого, і кожен стрибок
// коштує прочитаного ключа. Тому першим іде поле з меншою кількістю різних значень у межах.
db.tracks.createIndex(
  { explicit: 1, "audio_features.instrumentalness": 1, "audio_features.speechiness": 1 },
  { name: "explicit_instrumentalness_speechiness" }
);

summary("Після індексу { explicit: 1, audio_features.instrumentalness: 1, audio_features.speechiness: 1 }",
        db.tracks.find(workQuery).explain("executionStats"));

// Повний запит "фонова робота" з частини 2: loudness перевіряється вже після FETCH
summary("Запит з частини 2 (з loudness < -10) на тому ж індексі",
        db.tracks.find({ ...workQuery, "audio_features.loudness": { $lt: -10 } }).explain("executionStats"));

// Для порівняння: діапазони в іншому порядку
db.tracks.createIndex(
  { explicit: 1, "audio_features.speechiness": 1, "audio_features.instrumentalness": 1 },
  { name: "explicit_speechiness_instrumentalness" }
);
summary("Порівняння: індекс { explicit: 1, audio_features.speechiness: 1, audio_features.instrumentalness: 1 } через hint",
        db.tracks.find(workQuery).hint("explicit_speechiness_instrumentalness").explain("executionStats"));
db.tracks.dropIndex("explicit_speechiness_instrumentalness");


// ============================================================
// Завдання 3. Покривний запит (факультативне)
// ============================================================
print("\n=== Завдання 3. Покривний запит ===");

const coveredQuery = { track_genre: "pop", popularity: { $gte: 70 } };

summary("Запит з умови, без проєкції", db.tracks.find(coveredQuery).explain("executionStats"));

summary("Той самий фільтр з проєкцією { _id: 0, track_genre: 1, popularity: 1 }",
        db.tracks.find(coveredQuery, { _id: 0, track_genre: 1, popularity: 1 }).explain("executionStats"));

print("\nІндекси колекції tracks:");
db.tracks.getIndexes().forEach((ix) => print(` ${ix.name}: ${JSON.stringify(ix.key)}`));

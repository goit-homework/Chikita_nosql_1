// queries/part2_queries.js
// Запуск: mongosh "ВАШ_URI" --file queries/part2_queries.js

db = db.getSiblingDB("spotify");

// Друк масиву документів вирівняною таблицею
function table(rows, cols) {
  const cell = (v) => (Array.isArray(v) ? v.join(", ") : String(v));
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  print(cols.map((c, i) => c.padEnd(width[i])).join("  "));
  rows.forEach((r) => print(cols.map((c, i) => cell(r[c]).padEnd(width[i])).join("  ")));
}

// Датасет зібраний по жанрах, тож один track_id може стояти в кількох жанрах
// (89 740 різних треків на 113 999 документів). Для списків показуємо кожен трек один раз.
function uniqueTracks(filter, limit) {
  return db.tracks.aggregate([
    { $match: filter },
    { $group: {
        _id: "$track_id",
        track_name: { $first: "$track_name" },
        artists: { $first: "$artists" },
        popularity: { $max: "$popularity" },
        genres: { $addToSet: "$track_genre" }
    } },
    { $sort: { popularity: -1, _id: 1 } },
    { $limit: limit },
    { $project: { _id: 0, track_name: 1, artists: 1, popularity: 1, genres: { $sortArray: { input: "$genres", sortBy: 1 } } } }
  ]).toArray();
}


// ============================================================
// Завдання 1. Треки для вечірки
// danceability > 0.7, energy > 0.7, тривалість від 3 до 5 хвилин включно
// ============================================================
print("\n=== Завдання 1. Треки для вечірки ===");

const partyFilter = {
  "audio_features.danceability": { $gt: 0.7 },
  "audio_features.energy": { $gt: 0.7 },
  duration_ms: { $gte: 180000, $lte: 300000 }
};

const partyTracks = db.tracks.find(
  partyFilter,
  {
    _id: 0,
    track_name: 1,
    artists: 1,
    track_genre: 1,
    popularity: 1,
    duration_sec: 1,
    "audio_features.danceability": 1,
    "audio_features.energy": 1
  }
).sort({ popularity: -1, track_id: 1, track_genre: 1, _id: 1 });

print("Документів:", db.tracks.countDocuments(partyFilter));
print("Різних треків (track_id):", db.tracks.distinct("track_id", partyFilter).length);
print("\nПерші 5 документів курсора:");
partyTracks.limit(5).forEach((t) => printjson(t));
print("\nТоп-10 за популярністю, кожен трек один раз:");
table(uniqueTracks(partyFilter, 10), ["popularity", "track_name", "artists", "genres"]);


// ============================================================
// Завдання 2. Виконавці, у яких усі треки популярні
// мінімум 3 треки, мінімальна популярність >= 60, топ-20 за середньою популярністю
// ============================================================
print("\n=== Завдання 2. Виконавці, у яких усі треки популярні ===");

const popularArtists = db.tracks.aggregate([
  // масив виконавців розгортаємо: трек "Drake; Future" рахується і Drake, і Future
  { $unwind: "$artists" },
  // один трек артиста рахуємо один раз, навіть якщо він є в кількох жанрах
  { $group: {
      _id: { artist: "$artists", track_id: "$track_id" },
      popularity: { $max: "$popularity" }
  } },
  { $group: {
      _id: "$_id.artist",
      track_count: { $sum: 1 },
      min_popularity: { $min: "$popularity" },
      avg_popularity: { $avg: "$popularity" }
  } },
  { $match: { track_count: { $gte: 3 }, min_popularity: { $gte: 60 } } },
  { $sort: { avg_popularity: -1, track_count: -1, _id: 1 } },
  { $limit: 20 },
  { $project: {
      _id: 0,
      artist: "$_id",
      track_count: 1,
      min_popularity: { $round: ["$min_popularity", 1] },
      avg_popularity: { $round: ["$avg_popularity", 1] }
  } }
]).toArray();

table(popularArtists, ["artist", "track_count", "min_popularity", "avg_popularity"]);

// Скільки артистів проходить умову з дедуплікацією і без неї
function qualifyingArtists(dedupe) {
  const pipeline = [{ $unwind: "$artists" }];
  if (dedupe) {
    pipeline.push({ $group: { _id: { artist: "$artists", track_id: "$track_id" }, popularity: { $max: "$popularity" } } },
                  { $project: { artist: "$_id.artist", popularity: 1 } });
  } else {
    pipeline.push({ $project: { artist: "$artists", popularity: 1 } });
  }
  pipeline.push({ $group: { _id: "$artist", n: { $sum: 1 }, minp: { $min: "$popularity" } } },
                { $match: { n: { $gte: 3 }, minp: { $gte: 60 } } },
                { $count: "artists" });
  return db.tracks.aggregate(pipeline).toArray()[0].artists;
}
print("\nУсього артистів, що проходять умову:", qualifyingArtists(true),
      "| без дедуплікації треків було б:", qualifyingArtists(false));


// ============================================================
// Завдання 3. Нетипові треки
// tempo треку > середнє жанру + 2 * стандартне відхилення жанру
// ============================================================
print("\n=== Завдання 3. Нетипові треки ===");

const tempoOutliers = db.tracks.aggregate([
  // середнє і стандартне відхилення tempo по кожному жанру, треки жанру - у масив
  { $group: {
      _id: "$track_genre",
      avg_tempo: { $avg: "$audio_features.tempo" },
      std_tempo: { $stdDevPop: "$audio_features.tempo" },
      tracks: { $push: {
        _id: "$_id",
        track_name: "$track_name",
        popularity: "$popularity",
        artists: "$artists",
        tempo: "$audio_features.tempo"
      } }
  } },
  { $addFields: { threshold: { $add: ["$avg_tempo", { $multiply: [2, "$std_tempo"] }] } } },
  // залишаємо треки вище порогу, від найшвидшого
  { $project: {
      _id: 0,
      avg_tempo: { $round: ["$avg_tempo", 1] },
      genre: "$_id",
      outlier_threshold: { $round: ["$threshold", 1] },
      outlier_tracks: {
        $map: {
          input: {
            $sortArray: {
              input: { $filter: { input: "$tracks", as: "t", cond: { $gt: ["$$t.tempo", "$threshold"] } } },
              sortBy: { tempo: -1 }
            }
          },
          as: "t",
          in: {
            _id: "$$t._id",
            track_name: "$$t.track_name",
            popularity: "$$t.popularity",
            artists: "$$t.artists",
            audio_features: { tempo: "$$t.tempo" }
          }
        }
      }
  } },
  { $sort: { genre: 1 } }
]).toArray();

const outlierCount = tempoOutliers.reduce((s, g) => s + g.outlier_tracks.length, 0);
print("Жанрів:", tempoOutliers.length,
      "| з нетиповими треками:", tempoOutliers.filter((g) => g.outlier_tracks.length > 0).length,
      "| нетипових треків усього:", outlierCount);
print("Жанри без нетипових треків:",
      tempoOutliers.filter((g) => g.outlier_tracks.length === 0).map((g) => g.genre).join(", "));

print("\nДокумент для жанру acoustic (перші 3 треки з масиву):");
const acoustic = tempoOutliers.find((g) => g.genre === "acoustic");
printjson({ ...acoustic, outlier_tracks: acoustic.outlier_tracks.slice(0, 3) });
print(`... треків у масиві: ${acoustic.outlier_tracks.length}`);

print("\nПідсумок по жанрах з найбільшою кількістю нетипових треків:");
table(
  tempoOutliers
    .map((g) => ({ genre: g.genre, avg_tempo: g.avg_tempo, outlier_threshold: g.outlier_threshold,
                   outliers: g.outlier_tracks.length, fastest: g.outlier_tracks.length ? g.outlier_tracks[0].audio_features.tempo : "-" }))
    .sort((a, b) => b.outliers - a.outliers || a.genre.localeCompare(b.genre))
    .slice(0, 10),
  ["genre", "avg_tempo", "outlier_threshold", "outliers", "fastest"]
);


// ============================================================
// Завдання 4. Треки для фонової роботи
// loudness < -10, speechiness < 0.1, instrumentalness > 0.5, без explicit
// ============================================================
print("\n=== Завдання 4. Треки для фонової роботи ===");

const backgroundFilter = {
  "audio_features.loudness": { $lt: -10 },
  "audio_features.speechiness": { $lt: 0.1 },
  "audio_features.instrumentalness": { $gt: 0.5 },
  explicit: false
};

const backgroundTracks = db.tracks.find(
  backgroundFilter,
  {
    _id: 0,
    track_name: 1,
    artists: 1,
    track_genre: 1,
    popularity: 1,
    "audio_features.loudness": 1,
    "audio_features.speechiness": 1,
    "audio_features.instrumentalness": 1
  }
).sort({ popularity: -1, track_id: 1, track_genre: 1, _id: 1 });

print("Документів:", db.tracks.countDocuments(backgroundFilter));
print("Різних треків (track_id):", db.tracks.distinct("track_id", backgroundFilter).length);
print("\nПерші 5 документів курсора:");
backgroundTracks.limit(5).forEach((t) => printjson(t));
print("\nТоп-10 за популярністю, кожен трек один раз:");
table(uniqueTracks(backgroundFilter, 10), ["popularity", "track_name", "artists", "genres"]);

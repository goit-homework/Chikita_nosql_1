// queries/data_checks.js
// Перевірки даних, на які спирається README. Запуск після 02_transform.js:
// mongosh "ВАШ_URI" --file queries/data_checks.js

db = db.getSiblingDB("spotify");

const tempo = "$audio_features.tempo";

print("=== Дублікати треків між жанрами ===");
print("Документів:", db.tracks.countDocuments(), "| різних track_id:", db.tracks.distinct("track_id").length);
function histogram(field) {
  return db.tracks.aggregate([
    { $group: { _id: "$track_id", docs: { $sum: 1 }, genres: { $addToSet: "$track_genre" } } },
    { $group: { _id: field === "docs" ? "$docs" : { $size: "$genres" }, tracks: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray().map((x) => `${x._id}: ${x.tracks}`).join(", ");
}
print("У скількох різних жанрах трек -> кількість треків:", histogram("genres"));
print("Скільки документів має трек -> кількість треків:", histogram("docs"));
const dupRows = db.tracks.aggregate([
  { $group: { _id: { track_id: "$track_id", genre: "$track_genre" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $group: { _id: null, pairs: { $sum: 1 }, extra: { $sum: { $subtract: ["$n", 1] } }, maxCopies: { $max: "$n" } } }
]).toArray()[0];
print(`Однакові рядки в межах жанру: пар трек+жанр ${dupRows.pairs}, зайвих документів ${dupRows.extra}, найбільше копій ${dupRows.maxCopies}`);

const spread = db.tracks.aggregate([
  { $group: { _id: "$track_id", track_name: { $first: "$track_name" }, pops: { $addToSet: "$popularity" } } },
  { $match: { "pops.1": { $exists: true } } },
  { $project: { track_name: 1, spread: { $subtract: [{ $max: "$pops" }, { $min: "$pops" }] } } },
  { $sort: { spread: -1, _id: 1 } }
]).toArray();
print("Треків з різною популярністю в різних жанрах:", spread.length, "| найбільший розрив:", spread[0].spread, `(${spread[0].track_name})`);
db.tracks.find({ track_id: spread[0]._id }, { _id: 0, track_genre: 1, popularity: 1 }).sort({ track_genre: 1 })
  .forEach((d) => print(`  ${d.track_genre}: ${d.popularity}`));

print("\n=== popularity_tier ===");
db.tracks.aggregate([{ $group: { _id: "$popularity_tier", n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .forEach((x) => print(`  ${x._id}: ${x.n}`));

print("\n=== Масив artists ===");
print("Документів з кількома виконавцями:", db.tracks.countDocuments({ "artists.1": { $exists: true } }));
const most = db.tracks.aggregate([{ $project: { track_name: 1, n: { $size: "$artists" } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 1 }]).toArray()[0];
print("Найбільше виконавців в одному треку:", most.n, `(${most.track_name})`);
print("Точний збіг { artists: 'Drake' }:", db.tracks.countDocuments({ artists: "Drake" }), "документів,",
      db.tracks.distinct("track_id", { artists: "Drake" }).length, "різних треків");
print("Виконавці, які зачепив би пошук підрядка 'Drake':",
      db.tracks.aggregate([{ $unwind: "$artists" }, { $match: { artists: /Drake/ } }, { $group: { _id: "$artists", n: { $sum: 1 } } }, { $sort: { n: -1 } }])
        .toArray().map((x) => `${x._id} (${x.n})`).join(", "));
print("{ artists: { $all: ['Drake', 'Future'] } }:", db.tracks.countDocuments({ artists: { $all: ["Drake", "Future"] } }),
      "| { 'artists.0': 'Drake' }:", db.tracks.countDocuments({ "artists.0": "Drake" }));

print("\n=== Завдання 2: вибір популярності для дубліката не змінює результат ===");
function artists(acc) {
  return db.tracks.aggregate([
    { $unwind: "$artists" },
    { $group: { _id: { artist: "$artists", track_id: "$track_id" }, popularity: { [acc]: "$popularity" } } },
    { $group: { _id: "$_id.artist", n: { $sum: 1 }, minp: { $min: "$popularity" }, avgp: { $avg: "$popularity" } } },
    { $match: { n: { $gte: 3 }, minp: { $gte: 60 } } },
    { $sort: { avgp: -1, n: -1, _id: 1 } }
  ]).toArray().map((x) => x._id);
}
const byMax = artists("$max"), byMin = artists("$min");
print("Артистів з $max:", byMax.length, "| з $min:", byMin.length,
      "| склад однаковий:", JSON.stringify([...byMax].sort()) === JSON.stringify([...byMin].sort()),
      "| топ-20 однаковий:", JSON.stringify(byMax.slice(0, 20)) === JSON.stringify(byMin.slice(0, 20)));

print("\n=== Завдання 2: що вважати треком ===");
const plainTop = db.tracks.aggregate([
  { $unwind: "$artists" },
  { $group: { _id: "$artists", n: { $sum: 1 }, minp: { $min: "$popularity" }, avgp: { $avg: "$popularity" } } },
  { $match: { n: { $gte: 3 }, minp: { $gte: 60 } } },
  { $sort: { avgp: -1, n: -1, _id: 1 } },
  { $limit: 20 }
]).toArray().map((x) => x._id);
print("Без дедуплікації в топ-20 потрапили б замість інших:", plainTop.filter((a) => !byMax.slice(0, 20).includes(a)).join(", "));
print("Harry Styles за track_id:");
db.tracks.aggregate([
  { $match: { artists: "Harry Styles" } },
  { $group: { _id: "$track_id", track_name: { $first: "$track_name" }, album_name: { $first: "$album_name" }, popularity: { $max: "$popularity" } } },
  { $sort: { popularity: -1 } }
]).forEach((x) => print(`  ${x.track_name} (альбом ${x.album_name}): ${x.popularity}`));
// Та сама пісня на синглі й в альбомі має різні track_id. Варіант "пісня = виконавець + назва"
const bySong = db.tracks.aggregate([
  { $unwind: "$artists" },
  { $group: { _id: { artist: "$artists", song: { $toLower: { $trim: { input: "$track_name" } } } }, popularity: { $max: "$popularity" } } },
  { $group: { _id: "$_id.artist", n: { $sum: 1 }, minp: { $min: "$popularity" }, avgp: { $avg: "$popularity" } } },
  { $match: { n: { $gte: 3 }, minp: { $gte: 60 } } },
  { $sort: { avgp: -1, n: -1, _id: 1 } }
]).toArray();
print("Якщо рахувати пісні (виконавець + назва), умову проходять:", bySong.length, "артистів, Harry Styles серед них:",
      bySong.some((x) => x._id === "Harry Styles"));
const songNames = bySong.map((x) => x._id);
print("Порівняно з track_id: випадають", byMax.filter((a) => !songNames.includes(a)).length,
      "| додаються", songNames.filter((a) => !byMax.includes(a)).length);
print("Топ-5 за піснями:", bySong.slice(0, 5).map((x) => `${x._id} (${x.n}, ${x.avgp.toFixed(1)})`).join(", "));

print("\n=== Завдання 3: приклад з умови ===");
const ac = db.tracks.aggregate([{ $match: { track_genre: "acoustic" } }, { $group: { _id: null, avg: { $avg: tempo }, sd: { $stdDevPop: tempo } } }]).toArray()[0];
const olog = db.tracks.findOne({ track_genre: "acoustic", track_name: "The Legend of Olog-hai, Pt. 1" }, { _id: 0, "audio_features.tempo": 1 });
print(`acoustic: середнє ${ac.avg.toFixed(2)}, поріг ${(ac.avg + 2 * ac.sd).toFixed(2)}, The Legend of Olog-hai, Pt. 1: tempo ${olog.audio_features.tempo}`);

print("\n=== Завдання 3: нулі в tempo і форма розподілу ===");
print("Треків з tempo = 0:", db.tracks.countDocuments({ "audio_features.tempo": 0 }));
print("З них по жанрах:", db.tracks.aggregate([{ $match: { "audio_features.tempo": 0 } }, { $group: { _id: "$track_genre", n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 5 }])
  .toArray().map((x) => `${x._id} ${x.n}`).join(", "));

function genreStats(match) {
  return db.tracks.aggregate([
    { $match: match },
    { $group: { _id: "$track_genre", avg: { $avg: tempo }, sd: { $stdDevPop: tempo }, max: { $max: tempo }, t: { $push: tempo } } },
    { $addFields: { threshold: { $add: ["$avg", { $multiply: [2, "$sd"] }] } } }
  ]).toArray().map((g) => {
    const sorted = g.t.slice().sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const outliers = g.t.filter((x) => x > g.threshold);
    return { genre: g._id, avg: g.avg, sd: g.sd, max: g.max, threshold: g.threshold, median, sorted,
             outliers: outliers.length, nearDouble: outliers.filter((x) => x / median >= 1.8 && x / median <= 2.2).length,
             under100: g.t.filter((x) => x < 100).length };
  });
}

print("\n=== Завдання 3: записи, пари жанр+трек і різні треки ===");
const outlierIds = db.tracks.aggregate([
  { $group: { _id: "$track_genre", avg: { $avg: tempo }, sd: { $stdDevPop: tempo }, t: { $push: { id: "$track_id", tempo: tempo } } } },
  { $project: { o: { $filter: { input: "$t", as: "x", cond: { $gt: ["$$x.tempo", { $add: ["$avg", { $multiply: [2, "$sd"] }] }] } } } } },
  { $unwind: "$o" },
  { $group: { _id: null, records: { $sum: 1 }, pairs: { $addToSet: { genre: "$_id", track_id: "$o.id" } }, tracks: { $addToSet: "$o.id" } } }
]).toArray()[0];
print(`Нетипових записів: ${outlierIds.records}, різних пар жанр+трек: ${outlierIds.pairs.length}, різних треків: ${outlierIds.tracks.length}`);
const dedupOutliers = db.tracks.aggregate([
  { $group: { _id: { genre: "$track_genre", track_id: "$track_id" }, tempo: { $first: tempo } } },
  { $group: { _id: "$_id.genre", avg: { $avg: "$tempo" }, sd: { $stdDevPop: "$tempo" }, t: { $push: "$tempo" } } },
  { $project: { n: { $size: { $filter: { input: "$t", as: "x", cond: { $gt: ["$$x", { $add: ["$avg", { $multiply: [2, "$sd"] }] }] } } } } } },
  { $group: { _id: null, n: { $sum: "$n" } } }
]).toArray()[0].n;
print("Якщо спершу прибрати однакові рядки в межах жанру, нетипових:", dedupOutliers);
const all = genreStats({});
const noZero = genreStats({ "audio_features.tempo": { $gt: 0 } });
const fmt = (x) => x.toFixed(1);
print("Нетипових треків з нулями:", all.reduce((s, g) => s + g.outliers, 0),
      "| якщо відкинути tempo = 0:", noZero.reduce((s, g) => s + g.outliers, 0));
const sleep = all.find((g) => g.genre === "sleep"), sleepNZ = noZero.find((g) => g.genre === "sleep");
print(`sleep з нулями: середнє ${fmt(sleep.avg)}, поріг ${fmt(sleep.threshold)} | без нулів: середнє ${fmt(sleepNZ.avg)}, поріг ${fmt(sleepNZ.threshold)}`);
for (const name of ["drum-and-bass", "happy"]) {
  const g = all.find((x) => x.genre === name);
  print(`${name}: медіана ${fmt(g.median)}, треків до 100 BPM ${g.under100}, відхилення ${fmt(g.sd)}, поріг ${fmt(g.threshold)}, максимум ${fmt(g.max)}`);
}
const dnb = all.find((g) => g.genre === "drum-and-bass");
const slow = dnb.sorted.filter((x) => x < 100), smid = Math.floor(slow.length / 2);
const slowMedian = slow.length % 2 ? slow[smid] : (slow[smid - 1] + slow[smid]) / 2;
const bins = [[0, 80], [80, 85], [85, 90], [90, 95], [95, 100]].map(([a, b]) => `${a}-${b}: ${slow.filter((x) => x >= a && x < b).length}`);
print(`drum-and-bass до 100 BPM за інтервалами: ${bins.join(", ")} | медіана повільних, подвоєна: ${fmt(2 * slowMedian)}`);
const dh = all.find((g) => g.genre === "dancehall");
print(`dancehall: медіана ${fmt(dh.median)}, нетипових ${dh.outliers}, з них у 1.8-2.2 раза вище медіани ${dh.nearDouble}`);
print("По всіх жанрах нетипових у 1.8-2.2 раза вище медіани жанру:", all.reduce((s, g) => s + g.nearDouble, 0),
      "| жанрів, де такі є:", all.filter((g) => g.nearDouble > 0).length);
print("Найбільше таких (подвоєних з нетипових):", all.filter((g) => g.nearDouble > 0)
  .sort((a, b) => b.nearDouble - a.nearDouble || a.genre.localeCompare(b.genre)).slice(0, 8)
  .map((g) => `${g.genre} ${g.nearDouble} з ${g.outliers}`).join(", "));
print("Жанри, де всі нетипові (від 10) подвоєні:", all.filter((g) => g.outliers >= 10 && g.nearDouble === g.outliers)
  .sort((a, b) => a.genre.localeCompare(b.genre))
  .map((g) => `${g.genre} ${g.outliers}`).join(", "));

print("\n=== Частина 3: вибірковість умов завдання 2 ===");
print("instrumentalness > 0.5:", db.tracks.countDocuments({ "audio_features.instrumentalness": { $gt: 0.5 } }),
      "| speechiness < 0.1:", db.tracks.countDocuments({ "audio_features.speechiness": { $lt: 0.1 } }));

print("\n=== Ліміти Atlas M0: сортування в пам'яті до 32 МБ, без запису на диск ===");
function sortBytes(cursor) {
  for (let s = cursor.explain("executionStats").executionStats.executionStages; s; s = s.inputStage) {
    if (s.stage === "SORT") return s.totalDataSizeSorted;
  }
  return 0;
}
const partyFilter = { "audio_features.danceability": { $gt: 0.7 }, "audio_features.energy": { $gt: 0.7 }, duration_ms: { $gte: 180000, $lte: 300000 } };
const workFilter = { "audio_features.loudness": { $lt: -10 }, "audio_features.speechiness": { $lt: 0.1 },
                     "audio_features.instrumentalness": { $gt: 0.5 }, explicit: false };
const mb = (b) => (b / 1024 / 1024).toFixed(1);
print("Сортування завдання 2.1, МБ:", mb(sortBytes(db.tracks.find(partyFilter).sort({ popularity: -1, track_id: 1, track_genre: 1, _id: 1 }))),
      "| завдання 2.4, МБ:", mb(sortBytes(db.tracks.find(workFilter).sort({ popularity: -1, track_id: 1, track_genre: 1, _id: 1 }))));
const noDisk = { allowDiskUse: false };
db.tracks.aggregate([{ $unwind: "$artists" }, { $group: { _id: { a: "$artists", t: "$track_id" }, p: { $max: "$popularity" } } },
                     { $group: { _id: "$_id.a", n: { $sum: 1 } } }], noDisk).toArray();
db.tracks.aggregate([{ $group: { _id: "$track_genre", t: { $push: { _id: "$_id", track_name: "$track_name", popularity: "$popularity",
                     artists: "$artists", tempo: tempo } } } }], noDisk).toArray();
print("Групування завдань 2.2 і 2.3 з allowDiskUse: false: виконано без помилки");

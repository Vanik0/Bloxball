const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const db = new Database("data.db");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  stadium TEXT NOT NULL,
  founded INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  season TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'league',
  cup_legs INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS competition_teams (
  competition_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  PRIMARY KEY (competition_id, club_id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  market_value TEXT NOT NULL,
  bio TEXT NOT NULL,
  club_id INTEGER,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS player_clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  UNIQUE(player_id, club_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS referees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  login_username TEXT NOT NULL UNIQUE,
  login_password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_club_id INTEGER NOT NULL,
  to_club_id INTEGER NOT NULL,
  player_id INTEGER,
  transfer_offer_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  FOREIGN KEY (from_club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (to_club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL,
  FOREIGN KEY (transfer_offer_id) REFERENCES transfers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  from_club_id INTEGER,
  to_club_id INTEGER,
  fee TEXT NOT NULL,
  transfer_date TEXT NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (from_club_id) REFERENCES clubs(id) ON DELETE SET NULL,
  FOREIGN KEY (to_club_id) REFERENCES clubs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition TEXT NOT NULL,
  competition_id INTEGER,
  home_club_id INTEGER NOT NULL,
  away_club_id INTEGER NOT NULL,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  kickoff TEXT NOT NULL,
  status TEXT NOT NULL,
  referee_id INTEGER,
  round_number INTEGER DEFAULT 1,
  tie_number INTEGER DEFAULT 1,
  leg_number INTEGER DEFAULT 1,
  created_by_admin BOOLEAN DEFAULT 0,
  match_closed BOOLEAN DEFAULT 0,
  FOREIGN KEY (home_club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (away_club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (referee_id) REFERENCES referees(id) ON DELETE SET NULL
);
`);

function hasColumn(table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((item) => item.name === column);
}

function ensureColumns() {
  if (!hasColumn("clubs", "login_username")) {
    db.exec("ALTER TABLE clubs ADD COLUMN login_username TEXT");
  }

  if (!hasColumn("clubs", "login_password")) {
    db.exec("ALTER TABLE clubs ADD COLUMN login_password TEXT");
  }

  if (!hasColumn("matches", "competition_id")) {
    db.exec("ALTER TABLE matches ADD COLUMN competition_id INTEGER");
  }

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_login_username ON clubs(login_username) WHERE login_username IS NOT NULL"
  );
}

function ensureCompetitionColumns() {
  if (!hasColumn("competitions", "format")) {
    db.exec("ALTER TABLE competitions ADD COLUMN format TEXT NOT NULL DEFAULT 'league'");
  }

  if (!hasColumn("competitions", "login_username")) {
    db.exec("ALTER TABLE competitions ADD COLUMN login_username TEXT");
  }

  if (!hasColumn("competitions", "login_password")) {
    db.exec("ALTER TABLE competitions ADD COLUMN login_password TEXT");
  }

  if (!hasColumn("competitions", "cup_legs")) {
    db.exec("ALTER TABLE competitions ADD COLUMN cup_legs INTEGER NOT NULL DEFAULT 1");
  }

  db.exec("UPDATE competitions SET cup_legs = 1 WHERE cup_legs IS NULL OR cup_legs NOT IN (1, 2)");

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_competitions_login_username ON competitions(login_username) WHERE login_username IS NOT NULL"
  );

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_competition_teams_unique ON competition_teams(competition_id, club_id)"
  );
}

function ensurePlayerColumnsRemoved() {
  const columns = db.prepare("PRAGMA table_info(players)").all();
  const names = new Set(columns.map((column) => column.name));
  const needsMigration =
    names.has("age") || names.has("position") || names.has("nationality");

  if (!needsMigration) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS players_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        market_value TEXT NOT NULL,
        bio TEXT NOT NULL,
        club_id INTEGER,
        FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL
      );
    `);

    db.exec(`
      INSERT INTO players_new (id, full_name, market_value, bio, club_id)
      SELECT id, full_name, market_value, bio, club_id
      FROM players;
    `);

    db.exec("DROP TABLE players");
    db.exec("ALTER TABLE players_new RENAME TO players");
  });

  migrate();
  db.exec("PRAGMA foreign_keys = ON");
}

function ensureMatchColumns() {
  if (!hasColumn("matches", "referee_id")) {
    db.exec("ALTER TABLE matches ADD COLUMN referee_id INTEGER");
  }

  if (!hasColumn("matches", "round_number")) {
    db.exec("ALTER TABLE matches ADD COLUMN round_number INTEGER DEFAULT 1");
  }

  if (!hasColumn("matches", "tie_number")) {
    db.exec("ALTER TABLE matches ADD COLUMN tie_number INTEGER DEFAULT 1");
  }

  if (!hasColumn("matches", "leg_number")) {
    db.exec("ALTER TABLE matches ADD COLUMN leg_number INTEGER DEFAULT 1");
  }

  if (!hasColumn("matches", "created_by_admin")) {
    db.exec("ALTER TABLE matches ADD COLUMN created_by_admin BOOLEAN DEFAULT 0");
  }

  if (!hasColumn("matches", "match_closed")) {
    db.exec("ALTER TABLE matches ADD COLUMN match_closed BOOLEAN DEFAULT 0");
  }

  db.exec("UPDATE matches SET round_number = 1 WHERE round_number IS NULL OR round_number < 1");
  db.exec("UPDATE matches SET tie_number = 1 WHERE tie_number IS NULL OR tie_number < 1");
  db.exec("UPDATE matches SET leg_number = 1 WHERE leg_number IS NULL OR leg_number < 1");
}

function ensureNewTables() {
  // Create player_clubs table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_clubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      club_id INTEGER NOT NULL,
      UNIQUE(player_id, club_id),
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
    );
  `);

  // Create referees table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS referees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      login_username TEXT NOT NULL UNIQUE,
      login_password TEXT NOT NULL
    );
  `);

  // Create messages table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_club_id INTEGER NOT NULL,
      to_club_id INTEGER NOT NULL,
      player_id INTEGER,
      transfer_offer_id INTEGER,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      FOREIGN KEY (from_club_id) REFERENCES clubs(id) ON DELETE CASCADE,
      FOREIGN KEY (to_club_id) REFERENCES clubs(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL,
      FOREIGN KEY (transfer_offer_id) REFERENCES transfers(id) ON DELETE SET NULL
    );
  `);
}

function ensureDefaultCompetitionLogins() {
  const tx = db.transaction(() => {
    db.prepare("UPDATE competitions SET format = 'league' WHERE format IS NULL OR TRIM(format) = ''").run();

    const league = db.prepare("SELECT id FROM competitions WHERE name = ? LIMIT 1").get("Blox League");
    if (league) {
      db.prepare(
        `UPDATE competitions
         SET login_username = COALESCE(login_username, ?),
             login_password = COALESCE(login_password, ?)
         WHERE id = ?`
      ).run("league", "league123", league.id);
    }

    const cup = db.prepare("SELECT id FROM competitions WHERE name = ? LIMIT 1").get("Blox Cup");
    if (cup) {
      db.prepare(
        `UPDATE competitions
         SET login_username = COALESCE(login_username, ?),
             login_password = COALESCE(login_password, ?)
         WHERE id = ?`
      ).run("cup", "cup123", cup.id);
    }
  });

  tx();
}

ensureColumns();
ensureCompetitionColumns();
ensurePlayerColumnsRemoved();
ensureMatchColumns();
ensureNewTables();

function seedData() {
  const clubCount = db.prepare("SELECT COUNT(*) as count FROM clubs").get().count;
  const competitionCount = db.prepare("SELECT COUNT(*) as count FROM competitions").get().count;

  if (competitionCount === 0) {
    const insertCompetition = db.prepare(
      "INSERT INTO competitions (name, country, season, format, login_username, login_password) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insertCompetition.run("Blox League", "International", "2025/2026", "league", "league", "league123");
    insertCompetition.run("Blox Cup", "International", "2025/2026", "cup", "cup", "cup123");
  }

  if (clubCount > 0) {
    const fallbackCompetition = db
      .prepare("SELECT id FROM competitions ORDER BY id ASC LIMIT 1")
      .get();

    if (fallbackCompetition) {
      db.prepare("UPDATE matches SET competition_id = ? WHERE competition_id IS NULL").run(
        fallbackCompetition.id
      );
    }
    return;
  }

  const insertClub = db.prepare(
    "INSERT INTO clubs (name, country, city, stadium, founded, login_username, login_password) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const competition = db.prepare("SELECT id, name FROM competitions ORDER BY id ASC LIMIT 1").get();
  const insertPlayer = db.prepare(
    "INSERT INTO players (full_name, club_id, market_value, bio) VALUES (?, ?, ?, ?)"
  );
  const insertTransfer = db.prepare(
    "INSERT INTO transfers (player_id, from_club_id, to_club_id, fee, transfer_date, status) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertMatch = db.prepare(
    "INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertCompetitionTeam = db.prepare(
    "INSERT OR IGNORE INTO competition_teams (competition_id, club_id) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    const bloxburgClub = insertClub.run(
      "Bloxburg United",
      "CZ",
      "Praha",
      "Diamond Arena",
      2008,
      "bloxburg",
      "blox123"
    );
    const riversideClub = insertClub.run(
      "Riverside FC",
      "SK",
      "Bratislava",
      "Riverside Park",
      2011,
      "riverside",
      "river123"
    );
    const northValleyClub = insertClub.run("North Valley", "PL", "Krakow", "Valley Dome", 2005, null, null);

    if (competition) {
      insertCompetitionTeam.run(competition.id, bloxburgClub.lastInsertRowid);
      insertCompetitionTeam.run(competition.id, riversideClub.lastInsertRowid);
      insertCompetitionTeam.run(competition.id, northValleyClub.lastInsertRowid);
    }

    const novakPlayer = insertPlayer.run(
      "Marek Novak",
      bloxburgClub.lastInsertRowid,
      "8.5M EUR",
      "Rychly utocnik s dobrym zakoncenim."
    );
    const kralPlayer = insertPlayer.run(
      "Tomas Kral",
      riversideClub.lastInsertRowid,
      "5.2M EUR",
      "Tvurce hry a specialista na standardni situace."
    );
    insertPlayer.run(
      "Pawel Zielinski",
      northValleyClub.lastInsertRowid,
      "6.1M EUR",
      "Silny stoper, velmi dobry ve vzduchu."
    );

    insertTransfer.run(
      novakPlayer.lastInsertRowid,
      northValleyClub.lastInsertRowid,
      bloxburgClub.lastInsertRowid,
      "2.1M EUR",
      "2026-02-10",
      "Dokonceno"
    );
    insertTransfer.run(
      kralPlayer.lastInsertRowid,
      bloxburgClub.lastInsertRowid,
      riversideClub.lastInsertRowid,
      "1.5M EUR",
      "2026-03-01",
      "Dokonceno"
    );

    insertMatch.run(
      competition ? competition.name : "Blox League",
      competition ? competition.id : null,
      bloxburgClub.lastInsertRowid,
      riversideClub.lastInsertRowid,
      2,
      1,
      "2026-03-29 17:00",
      "LIVE"
    );
    insertMatch.run(
      competition ? competition.name : "Blox League",
      competition ? competition.id : null,
      northValleyClub.lastInsertRowid,
      bloxburgClub.lastInsertRowid,
      0,
      0,
      "2026-03-30 19:30",
      "UPCOMING"
    );
  });

  tx();
}

seedData();

function ensureDefaultReferees() {
  const refereeCount = db.prepare("SELECT COUNT(*) as count FROM referees").get().count;
  if (refereeCount === 0) {
    const hashedPassword = bcrypt.hashSync("referee123", 10);
    db.prepare(
      "INSERT INTO referees (name, login_username, login_password) VALUES (?, ?, ?)"
    ).run("John Smith", "referee1", hashedPassword);
    db.prepare(
      "INSERT INTO referees (name, login_username, login_password) VALUES (?, ?, ?)"
    ).run("Maria Garcia", "referee2", hashedPassword);
  }
}

ensureDefaultReferees();
ensureDefaultCompetitionLogins();

// Backfill team mappings from existing matches so standings can be computed immediately.
db.exec(`
INSERT OR IGNORE INTO competition_teams (competition_id, club_id)
SELECT competition_id, home_club_id
FROM matches
WHERE competition_id IS NOT NULL;
`);

db.exec(`
INSERT OR IGNORE INTO competition_teams (competition_id, club_id)
SELECT competition_id, away_club_id
FROM matches
WHERE competition_id IS NOT NULL;
`);

module.exports = db;

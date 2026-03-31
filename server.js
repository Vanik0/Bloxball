require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const db = require("./db");

const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  })
);

app.use((req, res, next) => {
  res.locals.isAdmin = Boolean(req.session.isAdmin);
  res.locals.isClub = Boolean(req.session.clubId);
  res.locals.clubName = req.session.clubName || null;
  res.locals.isCompetition = Boolean(req.session.competitionId);
  res.locals.competitionName = req.session.competitionName || null;
  res.locals.isReferee = Boolean(req.session.refereeId);
  res.locals.refereeName = req.session.refereeName || null;
  res.locals.currentPath = req.path;
  next();
});

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.redirect("/admin/login");
  }
  next();
}

function requireClub(req, res, next) {
  if (!req.session.clubId) {
    return res.redirect("/club/login");
  }
  next();
}

function requireCompetition(req, res, next) {
  if (!req.session.competitionId) {
    return res.redirect("/competition/login");
  }
  next();
}

function requireReferee(req, res, next) {
  if (!req.session.refereeId) {
    return res.redirect("/referee/login");
  }
  next();
}

function isHashed(value) {
  return typeof value === "string" && value.startsWith("$2");
}

function adminPasswordMatches(inputPassword) {
  const configured = process.env.ADMIN_PASSWORD || "admin123";

  if (isHashed(configured)) {
    return bcrypt.compareSync(inputPassword, configured);
  }

  return inputPassword === configured;
}

function passwordMatches(inputPassword, storedPassword) {
  if (!storedPassword) {
    return false;
  }

  if (isHashed(storedPassword)) {
    return bcrypt.compareSync(inputPassword, storedPassword);
  }

  return inputPassword === storedPassword;
}

function parseNullable(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function buildLeagueStandings(matches, teamIds) {
  const teamStats = new Map();
  for (const teamId of teamIds) {
    teamStats.set(teamId, {
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gf: 0,
      ga: 0,
      points: 0
    });
  }

  for (const match of matches) {
    const home = teamStats.get(match.home_club_id);
    const away = teamStats.get(match.away_club_id);
    if (!home || !away) {
      continue;
    }

    home.played += 1;
    away.played += 1;
    home.gf += Number(match.home_score);
    home.ga += Number(match.away_score);
    away.gf += Number(match.away_score);
    away.ga += Number(match.home_score);

    if (match.home_score > match.away_score) {
      home.wins += 1;
      home.points += 3;
      away.losses += 1;
    } else if (match.home_score < match.away_score) {
      away.wins += 1;
      away.points += 3;
      home.losses += 1;
    } else {
      home.draws += 1;
      away.draws += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  return teamStats;
}

function shuffleArray(values) {
  const items = [...values];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function buildRoundRobinRounds(teamIds, randomized = false) {
  const baseTeams = randomized ? shuffleArray(teamIds) : [...teamIds];
  if (baseTeams.length % 2 !== 0) {
    baseTeams.push(null);
  }

  const rounds = [];
  const teamCount = baseTeams.length;
  const halfSize = teamCount / 2;
  let rotation = [...baseTeams];

  for (let roundIndex = 0; roundIndex < teamCount - 1; roundIndex += 1) {
    const matches = [];

    for (let i = 0; i < halfSize; i += 1) {
      const first = rotation[i];
      const second = rotation[teamCount - 1 - i];
      if (first === null || second === null) {
        continue;
      }

      // Alternate home advantage between rounds to keep schedule fair.
      const home = roundIndex % 2 === 0 ? first : second;
      const away = roundIndex % 2 === 0 ? second : first;
      matches.push({ home, away });
    }

    rounds.push(matches);

    const fixed = rotation[0];
    const rotating = rotation.slice(1);
    rotating.unshift(rotating.pop());
    rotation = [fixed, ...rotating];
  }

  return rounds;
}

function getCupRoundLabel(roundNumber, maxRound) {
  const distanceToFinal = maxRound - roundNumber;
  if (distanceToFinal === 0) {
    return "Finale";
  }
  if (distanceToFinal === 1) {
    return "Semifinále";
  }
  if (distanceToFinal === 2) {
    return "Čtvrtfinále";
  }
  return `Kolo ${roundNumber}`;
}

function normalizeCupLegs(value) {
  return Number(value) === 2 ? 2 : 1;
}

function insertCupRoundMatches(competition, competitionId, teams, roundNumber, kickoffBaseDate, cupLegs) {
  let matchDate = new Date(kickoffBaseDate.getTime());
  let tieNumber = 1;

  for (let i = 0; i + 1 < teams.length; i += 2) {
    const homeTeamId = teams[i];
    const awayTeamId = teams[i + 1];

    const firstKickoff = matchDate.toISOString().slice(0, 16).replace("T", " ");
    db.prepare(
      `INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status, round_number, tie_number, leg_number, created_by_admin)
       VALUES (?, ?, ?, ?, 0, 0, ?, 'UPCOMING', ?, ?, 1, 1)`
    ).run(competition.name, competitionId, homeTeamId, awayTeamId, firstKickoff, roundNumber, tieNumber);

    if (cupLegs === 2) {
      const secondLegDate = new Date(matchDate.getTime() + 3 * 24 * 60 * 60 * 1000);
      const secondKickoff = secondLegDate.toISOString().slice(0, 16).replace("T", " ");
      db.prepare(
        `INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status, round_number, tie_number, leg_number, created_by_admin)
         VALUES (?, ?, ?, ?, 0, 0, ?, 'UPCOMING', ?, ?, 2, 1)`
      ).run(competition.name, competitionId, awayTeamId, homeTeamId, secondKickoff, roundNumber, tieNumber);
    }

    tieNumber += 1;
    matchDate.setDate(matchDate.getDate() + 7);
  }
}

function resolveCupTieWinner(tieMatches) {
  if (!tieMatches || tieMatches.length === 0) {
    return null;
  }

  const allFinished = tieMatches.every((match) => String(match.status || "").toUpperCase() === "FT");
  if (!allFinished) {
    return null;
  }

  const first = tieMatches[0];
  const teamA = first.home_club_id;
  const teamB = first.away_club_id;
  let goalsA = 0;
  let goalsB = 0;

  for (const match of tieMatches) {
    if (match.home_club_id === teamA) {
      goalsA += Number(match.home_score || 0);
      goalsB += Number(match.away_score || 0);
    } else {
      goalsA += Number(match.away_score || 0);
      goalsB += Number(match.home_score || 0);
    }
  }

  if (goalsA > goalsB) return teamA;
  if (goalsB > goalsA) return teamB;

  // Tie-breaker: winner of the latest leg; if still draw, deterministic fallback by lower club id.
  const latestLeg = [...tieMatches].sort((a, b) => {
    const byLeg = Number(a.leg_number || 1) - Number(b.leg_number || 1);
    if (byLeg !== 0) return byLeg;
    return Number(a.id) - Number(b.id);
  }).at(-1);

  if (Number(latestLeg.home_score) > Number(latestLeg.away_score)) {
    return latestLeg.home_club_id;
  }
  if (Number(latestLeg.home_score) < Number(latestLeg.away_score)) {
    return latestLeg.away_club_id;
  }

  return Math.min(teamA, teamB);
}

function tryAdvanceCupCompetition(competitionId) {
  const competition = db.prepare("SELECT * FROM competitions WHERE id = ?").get(competitionId);
  if (!competition || String(competition.format || "").toLowerCase() !== "cup") {
    return;
  }

  const cupLegs = normalizeCupLegs(competition.cup_legs);
  const rounds = db
    .prepare("SELECT DISTINCT round_number FROM matches WHERE competition_id = ? ORDER BY round_number ASC")
    .all(competitionId)
    .map((row) => Number(row.round_number || 1));

  for (const roundNumber of rounds) {
    const nextRoundExists = db
      .prepare("SELECT 1 FROM matches WHERE competition_id = ? AND round_number = ? LIMIT 1")
      .get(competitionId, roundNumber + 1);
    if (nextRoundExists) {
      continue;
    }

    const roundMatches = db
      .prepare(
        `SELECT *
         FROM matches
         WHERE competition_id = ? AND round_number = ?
         ORDER BY tie_number ASC, leg_number ASC, id ASC`
      )
      .all(competitionId, roundNumber);

    if (roundMatches.length === 0) {
      continue;
    }

    const ties = new Map();
    for (const match of roundMatches) {
      const tieKey = Number(match.tie_number || match.id);
      if (!ties.has(tieKey)) {
        ties.set(tieKey, []);
      }
      ties.get(tieKey).push(match);
    }

    const orderedTieKeys = Array.from(ties.keys()).sort((a, b) => a - b);
    const winners = [];
    for (const tieKey of orderedTieKeys) {
      const winner = resolveCupTieWinner(ties.get(tieKey));
      if (!winner) {
        return;
      }
      winners.push(winner);
    }

    if (winners.length < 2) {
      return;
    }

    if (winners.length % 2 !== 0) {
      // Odd winners are not supported in automatic progression without bye placeholders.
      return;
    }

    const latestKickoffInRound = roundMatches.at(-1)?.kickoff;
    const baseDate = latestKickoffInRound
      ? new Date(String(latestKickoffInRound).replace(" ", "T"))
      : new Date();
    baseDate.setDate(baseDate.getDate() + 7);

    insertCupRoundMatches(competition, competitionId, winners, roundNumber + 1, baseDate, cupLegs);
  }
}

app.get("/competitions", (req, res) => {
  const competitions = db
    .prepare("SELECT * FROM competitions ORDER BY name ASC")
    .all();

  const competitionDetails = competitions.map(competition => {
    const normalizedFormat = String(competition.format || "").trim().toLowerCase();
    const normalizedName = String(competition.name || "").trim().toLowerCase();
    const isCup = normalizedFormat === "cup" || normalizedName.includes("cup") || normalizedName.includes("poh");
    const teams = db
      .prepare(
        `SELECT c.id, c.name
         FROM competition_teams ct
         JOIN clubs c ON c.id = ct.club_id
         WHERE ct.competition_id = ?
         ORDER BY c.name ASC`
      )
      .all(competition.id);

    const playedMatches = db
      .prepare(
        `SELECT home_club_id, away_club_id, home_score, away_score
         FROM matches
         WHERE competition_id = ?
           AND UPPER(status) != 'UPCOMING'`
      )
      .all(competition.id);

    const teamIds = teams.map((team) => team.id);
    const standingsMap = buildLeagueStandings(playedMatches, teamIds);
    const standings = teams
      .map((team) => {
        const stat = standingsMap.get(team.id) || {
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          gf: 0,
          ga: 0,
          points: 0
        };
        return {
          club_id: team.id,
          club_name: team.name,
          ...stat,
          gd: stat.gf - stat.ga
        };
      })
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.gd !== a.gd) return b.gd - a.gd;
        if (b.gf !== a.gf) return b.gf - a.gf;
        return a.club_name.localeCompare(b.club_name, "cs");
      });

    const matches = db
      .prepare(
        `SELECT m.*, h.name AS home_name, a.name AS away_name
         FROM matches m
         JOIN clubs h ON h.id = m.home_club_id
         JOIN clubs a ON a.id = m.away_club_id
         WHERE m.competition_id = ?
         ORDER BY COALESCE(m.round_number, 1) ASC, m.kickoff ASC, m.id ASC`
      )
      .all(competition.id);

    const roundsMap = new Map();
    for (const match of matches) {
      const roundNumber = Number(match.round_number || 1);
      if (!roundsMap.has(roundNumber)) {
        roundsMap.set(roundNumber, []);
      }
      roundsMap.get(roundNumber).push(match);
    }

    const rounds = Array.from(roundsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([roundNumber, roundMatches]) => ({
        roundNumber,
        matches: roundMatches
      }));

    const maxCupRound = rounds.length > 0 ? rounds[rounds.length - 1].roundNumber : 1;
    const cupBracketRounds = rounds.map((round) => ({
      ...round,
      label: getCupRoundLabel(round.roundNumber, maxCupRound)
    }));

    return {
      ...competition,
      isCup,
      teams,
      standings,
      matches,
      rounds,
      cupBracketRounds
    };
  });

  res.render("competitions", { competitions: competitionDetails });
});

app.get("/",(req, res) => {
  const matches = db
    .prepare(
      `SELECT
        m.*,
        COALESCE(cmp.name, m.competition) AS competition_name,
        h.name AS home_name,
        a.name AS away_name
      FROM matches m
      LEFT JOIN competitions cmp ON cmp.id = m.competition_id
      JOIN clubs h ON h.id = m.home_club_id
      JOIN clubs a ON a.id = m.away_club_id
      ORDER BY m.kickoff ASC`
    )
    .all();

  const latestTransfers = db
    .prepare(
      `SELECT
        t.*,
        p.full_name AS player_name,
        c_from.name AS from_name,
        c_to.name AS to_name
      FROM transfers t
      JOIN players p ON p.id = t.player_id
      LEFT JOIN clubs c_from ON c_from.id = t.from_club_id
      LEFT JOIN clubs c_to ON c_to.id = t.to_club_id
      ORDER BY t.transfer_date DESC
      LIMIT 5`
    )
    .all();

  const leagueCompetitions = db
    .prepare(
      `SELECT *
       FROM competitions
       WHERE LOWER(format) = 'league'
       ORDER BY name ASC`
    )
    .all();

  const leagueTables = leagueCompetitions.map((competition) => {
    const teams = db
      .prepare(
        `SELECT c.id, c.name
         FROM competition_teams ct
         JOIN clubs c ON c.id = ct.club_id
         WHERE ct.competition_id = ?
         ORDER BY c.name ASC`
      )
      .all(competition.id);

    const playedMatches = db
      .prepare(
        `SELECT home_club_id, away_club_id, home_score, away_score
         FROM matches
         WHERE competition_id = ?
           AND UPPER(status) != 'UPCOMING'`
      )
      .all(competition.id);

    const teamIds = teams.map((team) => team.id);
    const stats = buildLeagueStandings(playedMatches, teamIds);
    const rows = teams
      .map((team) => {
        const stat = stats.get(team.id) || {
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          gf: 0,
          ga: 0,
          points: 0
        };
        return {
          club_id: team.id,
          club_name: team.name,
          ...stat,
          gd: stat.gf - stat.ga
        };
      })
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.gd !== a.gd) return b.gd - a.gd;
        if (b.gf !== a.gf) return b.gf - a.gf;
        return a.club_name.localeCompare(b.club_name, "cs");
      });

    return {
      competition,
      rows
    };
  });

  res.render("home", { matches, latestTransfers, leagueTables });
});

app.get("/players", (req, res) => {
  const players = db
    .prepare(
      `SELECT p.*, c.name as club_name
      FROM players p
      LEFT JOIN clubs c ON c.id = p.club_id
      ORDER BY p.full_name ASC`
    )
    .all();

  const secondaryRows = db
    .prepare(
      `SELECT pc.player_id, pc.club_id, c.name AS club_name
      FROM player_clubs pc
      JOIN clubs c ON c.id = pc.club_id
      JOIN players p ON p.id = pc.player_id
      WHERE p.club_id IS NULL OR pc.club_id != p.club_id
      ORDER BY c.name ASC`
    )
    .all();

  const secondaryMap = secondaryRows.reduce((acc, row) => {
    if (!acc[row.player_id]) {
      acc[row.player_id] = [];
    }
    acc[row.player_id].push(row.club_name);
    return acc;
  }, {});

  const playersWithSecondaryClubs = players.map((player) => ({
    ...player,
    secondary_clubs: (secondaryMap[player.id] || []).join(", ")
  }));

  res.render("players", { players: playersWithSecondaryClubs });
});

app.get("/players/:id", (req, res) => {
  const player = db
    .prepare(
      `SELECT p.*, c.name as club_name
      FROM players p
      LEFT JOIN clubs c ON c.id = p.club_id
      WHERE p.id = ?`
    )
    .get(req.params.id);

  if (!player) {
    return res.status(404).render("not-found", { message: "Profil hrace nebyl nalezen." });
  }

  const secondaryClubs = db
    .prepare(
      `SELECT c.id, c.name
      FROM player_clubs pc
      JOIN clubs c ON c.id = pc.club_id
      WHERE pc.player_id = ?
      ORDER BY c.name ASC`
    )
    .all(req.params.id)
    .filter((club) => Number(club.id) !== Number(player.club_id));

  const transfers = db
    .prepare(
      `SELECT
        t.*,
        c_from.name AS from_name,
        c_to.name AS to_name
      FROM transfers t
      LEFT JOIN clubs c_from ON c_from.id = t.from_club_id
      LEFT JOIN clubs c_to ON c_to.id = t.to_club_id
      WHERE t.player_id = ?
      ORDER BY t.transfer_date DESC`
    )
    .all(req.params.id);

  res.render("player-profile", { player, transfers, secondaryClubs });
});

app.get("/clubs", (req, res) => {
  const clubs = db.prepare("SELECT * FROM clubs ORDER BY name ASC").all();
  res.render("clubs", { clubs });
});

app.get("/transfers", (req, res) => {
  const transfers = db
    .prepare(
      `SELECT
        t.*,
        p.full_name AS player_name,
        c_from.name AS from_name,
        c_to.name AS to_name
      FROM transfers t
      JOIN players p ON p.id = t.player_id
      LEFT JOIN clubs c_from ON c_from.id = t.from_club_id
      LEFT JOIN clubs c_to ON c_to.id = t.to_club_id
      ORDER BY t.transfer_date DESC`
    )
    .all();

  res.render("transfers", { transfers });
});

app.get("/admin/login", (req, res) => {
  if (req.session.isAdmin) {
    return res.redirect("/admin");
  }
  res.render("admin-login", { error: null });
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  const adminUser = process.env.ADMIN_USER || "admin";

  if (username === adminUser && adminPasswordMatches(password)) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }

  return res.status(401).render("admin-login", { error: "Neplatne prihlasovaci udaje." });
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/admin", requireAdmin, (req, res) => {
  const clubs = db.prepare("SELECT * FROM clubs ORDER BY name ASC").all();
  const competitions = db.prepare("SELECT * FROM competitions ORDER BY name ASC").all();
  const competitionTeamsRows = db
    .prepare(
      `SELECT ct.competition_id, ct.club_id, c.name AS club_name
       FROM competition_teams ct
       JOIN clubs c ON c.id = ct.club_id
       ORDER BY c.name ASC`
    )
    .all();

  const competitionTeamsByCompetition = competitionTeamsRows.reduce((acc, row) => {
    if (!acc[row.competition_id]) {
      acc[row.competition_id] = [];
    }
    acc[row.competition_id].push({ club_id: row.club_id, club_name: row.club_name });
    return acc;
  }, {});

  const players = db
    .prepare(
      `SELECT p.*, c.name as club_name
       FROM players p
       LEFT JOIN clubs c ON c.id = p.club_id
       ORDER BY p.full_name ASC`
    )
    .all();
  const playerSecondaryClubsRows = db
    .prepare(
      `SELECT pc.player_id, pc.club_id, c.name AS club_name
       FROM player_clubs pc
       JOIN clubs c ON c.id = pc.club_id
       JOIN players p ON p.id = pc.player_id
       WHERE p.club_id IS NULL OR pc.club_id != p.club_id
       ORDER BY c.name ASC`
    )
    .all();
  const playerSecondaryClubsByPlayer = playerSecondaryClubsRows.reduce((acc, row) => {
    if (!acc[row.player_id]) {
      acc[row.player_id] = [];
    }
    acc[row.player_id].push({ club_id: row.club_id, club_name: row.club_name });
    return acc;
  }, {});
  const transfers = db
    .prepare(
      `SELECT t.*, p.full_name AS player_name, c_from.name AS from_name, c_to.name AS to_name
       FROM transfers t
       JOIN players p ON p.id = t.player_id
       LEFT JOIN clubs c_from ON c_from.id = t.from_club_id
       LEFT JOIN clubs c_to ON c_to.id = t.to_club_id
       ORDER BY t.transfer_date DESC`
    )
    .all();
  const matches = db
    .prepare(
      `SELECT m.*, COALESCE(cmp.name, m.competition) AS competition_name, h.name AS home_name, a.name AS away_name, r.name AS referee_name
       FROM matches m
       LEFT JOIN competitions cmp ON cmp.id = m.competition_id
       LEFT JOIN referees r ON r.id = m.referee_id
       JOIN clubs h ON h.id = m.home_club_id
       JOIN clubs a ON a.id = m.away_club_id
       ORDER BY m.kickoff DESC`
    )
    .all();
  const referees = db.prepare("SELECT * FROM referees ORDER BY name ASC").all();

  res.render("admin-dashboard", {
    clubs,
    players,
    playerSecondaryClubsByPlayer,
    competitions,
    transfers,
    matches,
    referees,
    competitionTeamsByCompetition
  });
});

app.post("/admin/clubs/create", requireAdmin, (req, res) => {
  const { name, country, city, stadium, founded, login_username, login_password } = req.body;

  const username = parseNullable(login_username);
  const password = parseNullable(login_password);
  const passwordValue = password ? bcrypt.hashSync(password, 10) : null;

  db.prepare(
    "INSERT INTO clubs (name, country, city, stadium, founded, login_username, login_password) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(name, country, city, stadium, Number(founded), username, passwordValue);

  res.redirect("/admin");
});

app.post("/admin/clubs/:id/update", requireAdmin, (req, res) => {
  const { name, country, city, stadium, founded, login_username, login_password } = req.body;
  const existing = db.prepare("SELECT login_password FROM clubs WHERE id = ?").get(req.params.id);
  const username = parseNullable(login_username);
  const password = parseNullable(login_password);
  const nextPassword = password
    ? bcrypt.hashSync(password, 10)
    : existing
      ? existing.login_password
      : null;

  db.prepare(
    "UPDATE clubs SET name = ?, country = ?, city = ?, stadium = ?, founded = ?, login_username = ?, login_password = ? WHERE id = ?"
  ).run(name, country, city, stadium, Number(founded), username, nextPassword, req.params.id);

  res.redirect("/admin");
});

app.post("/admin/clubs/:id/delete", requireAdmin, (req, res) => {
  db.prepare("UPDATE players SET club_id = NULL WHERE club_id = ?").run(req.params.id);
  db.prepare("DELETE FROM clubs WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

app.post("/admin/players/create", requireAdmin, (req, res) => {
  const { full_name, club_id, market_value, bio } = req.body;

  const playerSchema = db.prepare("PRAGMA table_info(players)").all();
  const schemaColumns = new Set(playerSchema.map((column) => column.name));

  const payloadByColumn = {
    full_name,
    age: 18,
    position: "N/A",
    nationality: "N/A",
    club_id: club_id ? Number(club_id) : null,
    market_value,
    bio
  };

  const insertColumns = Object.keys(payloadByColumn).filter((column) => schemaColumns.has(column));
  const placeholders = insertColumns.map(() => "?").join(", ");
  const values = insertColumns.map((column) => payloadByColumn[column]);

  db.prepare(`INSERT INTO players (${insertColumns.join(", ")}) VALUES (${placeholders})`).run(...values);

  res.redirect("/admin");
});

app.post("/admin/players/:id/update", requireAdmin, (req, res) => {
  const { full_name, club_id, market_value, bio } = req.body;

  db.prepare(
    `UPDATE players
     SET full_name = ?, club_id = ?, market_value = ?, bio = ?
     WHERE id = ?`
  ).run(full_name, club_id ? Number(club_id) : null, market_value, bio, req.params.id);

  res.redirect("/admin");
});

app.post("/admin/players/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM players WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

app.post("/admin/players/:id/add-club", requireAdmin, (req, res) => {
  const { club_id } = req.body;
  const playerId = Number(req.params.id);
  const clubId = Number(club_id);

  // Check if player and club exist
  const player = db.prepare("SELECT id FROM players WHERE id = ?").get(playerId);
  const club = db.prepare("SELECT id FROM clubs WHERE id = ?").get(clubId);

  if (!player || !club) {
    return res.redirect("/admin");
  }

  // Add club to player's club list if not already present
  db.prepare("INSERT OR IGNORE INTO player_clubs (player_id, club_id) VALUES (?, ?)").run(playerId, clubId);

  res.redirect("/admin");
});

app.post("/admin/players/:id/remove-club", requireAdmin, (req, res) => {
  const { club_id } = req.body;
  const playerId = Number(req.params.id);
  const clubId = Number(club_id);

  db.prepare("DELETE FROM player_clubs WHERE player_id = ? AND club_id = ?").run(playerId, clubId);

  res.redirect("/admin");
});

app.post("/admin/transfers/create", requireAdmin, (req, res) => {
  const { player_id, from_club_id, to_club_id, fee, transfer_date, status } = req.body;

  const playerId = Number(player_id);
  
  db.prepare(
    `INSERT INTO transfers (player_id, from_club_id, to_club_id, fee, transfer_date, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    playerId,
    from_club_id ? Number(from_club_id) : null,
    to_club_id ? Number(to_club_id) : null,
    fee,
    transfer_date,
    status
  );

  // If transfer is marked as completed, update player's club
  if (status && status.toLowerCase() === "dokonceno") {
    const toClubId = to_club_id ? Number(to_club_id) : null;
    db.prepare("UPDATE players SET club_id = ? WHERE id = ?").run(toClubId, playerId);
  }

  res.redirect("/admin");
});

app.post("/admin/transfers/:id/update", requireAdmin, (req, res) => {
  const { player_id, from_club_id, to_club_id, fee, transfer_date, status } = req.body;

  const playerId = Number(player_id);
  const transferId = Number(req.params.id);
  
  db.prepare(
    `UPDATE transfers 
     SET player_id = ?, from_club_id = ?, to_club_id = ?, fee = ?, transfer_date = ?, status = ?
     WHERE id = ?`
  ).run(
    playerId,
    from_club_id ? Number(from_club_id) : null,
    to_club_id ? Number(to_club_id) : null,
    fee,
    transfer_date,
    status,
    transferId
  );

  // If transfer is marked as completed, update player's club
  if (status && status.toLowerCase() === "dokonceno") {
    const toClubId = to_club_id ? Number(to_club_id) : null;
    db.prepare("UPDATE players SET club_id = ? WHERE id = ?").run(toClubId, playerId);
  }

  res.redirect("/admin");
});

app.post("/admin/transfers/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM transfers WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

app.post("/admin/matches/create", requireAdmin, (req, res) => {
  const {
    competition_id,
    home_club_id,
    away_club_id,
    home_score,
    away_score,
    kickoff,
    status,
    referee_id,
    round_number
  } = req.body;

  const competition = db.prepare("SELECT id, name FROM competitions WHERE id = ?").get(competition_id);

  if (!competition) {
    return res.redirect("/admin");
  }

  const homeClubId = Number(home_club_id);
  const awayClubId = Number(away_club_id);
  if (homeClubId === awayClubId) {
    return res.redirect("/admin");
  }

  const allowedTeams = db
    .prepare("SELECT club_id FROM competition_teams WHERE competition_id = ?")
    .all(competition.id)
    .map((row) => row.club_id);

  if (!allowedTeams.includes(homeClubId) || !allowedTeams.includes(awayClubId)) {
    return res.redirect("/admin");
  }

  db.prepare(
    `INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status, referee_id, round_number, created_by_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    competition.name,
    competition.id,
    homeClubId,
    awayClubId,
    Number(home_score),
    Number(away_score),
    kickoff,
    status,
    referee_id ? Number(referee_id) : null,
    Math.max(1, Number(round_number) || 1)
  );

  res.redirect("/admin");
});

app.post("/admin/matches/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM matches WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

app.post("/admin/competitions/create", requireAdmin, (req, res) => {
  const { name, country, season, format, cup_legs, login_username, login_password } = req.body;

  const username = parseNullable(login_username);
  const password = parseNullable(login_password);
  const passwordValue = password ? bcrypt.hashSync(password, 10) : null;
  const competitionFormat = format === "cup" ? "cup" : "league";
  const cupLegs = competitionFormat === "cup" ? normalizeCupLegs(cup_legs) : 1;

  db.prepare(
    "INSERT INTO competitions (name, country, season, format, cup_legs, login_username, login_password) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(name, country, season, competitionFormat, cupLegs, username, passwordValue);

  res.redirect("/admin");
});

app.post("/admin/competitions/:id/update", requireAdmin, (req, res) => {
  const { name, country, season, format, cup_legs, login_username, login_password } = req.body;
  const existing = db.prepare("SELECT login_password FROM competitions WHERE id = ?").get(req.params.id);
  const username = parseNullable(login_username);
  const password = parseNullable(login_password);
  const nextPassword = password
    ? bcrypt.hashSync(password, 10)
    : existing
      ? existing.login_password
      : null;
  const competitionFormat = format === "cup" ? "cup" : "league";
  const cupLegs = competitionFormat === "cup" ? normalizeCupLegs(cup_legs) : 1;

  db.prepare(
    "UPDATE competitions SET name = ?, country = ?, season = ?, format = ?, cup_legs = ?, login_username = ?, login_password = ? WHERE id = ?"
  ).run(name, country, season, competitionFormat, cupLegs, username, nextPassword, req.params.id);

  db.prepare("UPDATE matches SET competition = ? WHERE competition_id = ?").run(name, req.params.id);

  res.redirect("/admin");
});

app.post("/admin/competitions/:id/teams/add", requireAdmin, (req, res) => {
  const competitionId = Number(req.params.id);
  const clubId = Number(req.body.club_id);

  const competition = db.prepare("SELECT id FROM competitions WHERE id = ?").get(competitionId);
  const club = db.prepare("SELECT id FROM clubs WHERE id = ?").get(clubId);

  if (!competition || !club) {
    return res.redirect("/admin");
  }

  db.prepare("INSERT OR IGNORE INTO competition_teams (competition_id, club_id) VALUES (?, ?)").run(
    competitionId,
    clubId
  );

  res.redirect("/admin");
});

app.post("/admin/competitions/:id/teams/:clubId/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM competition_teams WHERE competition_id = ? AND club_id = ?").run(
    Number(req.params.id),
    Number(req.params.clubId)
  );

  res.redirect("/admin");
});

app.post("/admin/competitions/:id/delete", requireAdmin, (req, res) => {
  db.prepare("UPDATE matches SET competition_id = NULL WHERE competition_id = ?").run(req.params.id);
  db.prepare("DELETE FROM competitions WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

app.get("/competition/login", (req, res) => {
  if (req.session.competitionId) {
    return res.redirect("/competition");
  }
  res.render("competition-login", { error: null });
});

app.post("/competition/login", (req, res) => {
  const { username, password } = req.body;
  const competition = db.prepare("SELECT * FROM competitions WHERE login_username = ?").get(username);

  if (competition && passwordMatches(password, competition.login_password)) {
    req.session.competitionId = competition.id;
    req.session.competitionName = competition.name;
    return res.redirect("/competition");
  }

  return res.status(401).render("competition-login", { error: "Neplatne prihlaseni souteze." });
});

app.post("/competition/logout", requireCompetition, (req, res) => {
  delete req.session.competitionId;
  delete req.session.competitionName;
  res.redirect("/");
});

app.get("/competition", requireCompetition, (req, res) => {
  const competition = db.prepare("SELECT * FROM competitions WHERE id = ?").get(req.session.competitionId);
  const normalizedFormat = String((competition && competition.format) || "").trim().toLowerCase();
  const normalizedName = String((competition && competition.name) || "").trim().toLowerCase();
  const isCup = normalizedFormat === "cup" || normalizedName.includes("cup") || normalizedName.includes("poh");

  if (!competition) {
    delete req.session.competitionId;
    delete req.session.competitionName;
    return res.redirect("/competition/login");
  }

  const matches = db
    .prepare(
      `SELECT m.*, h.name AS home_name, a.name AS away_name
       FROM matches m
       LEFT JOIN competitions c ON c.id = m.competition_id
       JOIN clubs h ON h.id = m.home_club_id
       JOIN clubs a ON a.id = m.away_club_id
       WHERE m.competition_id = ?
       ORDER BY COALESCE(m.round_number, 1) ASC, m.kickoff ASC, m.id ASC`
    )
    .all(competition.id);

  const allClubs = db
    .prepare(
      `SELECT c.*
       FROM competition_teams ct
       JOIN clubs c ON c.id = ct.club_id
       WHERE ct.competition_id = ?
       ORDER BY c.name ASC`
    )
    .all(competition.id);

  const playedMatches = db
    .prepare(
      `SELECT home_club_id, away_club_id, home_score, away_score
       FROM matches
       WHERE competition_id = ?
         AND UPPER(status) != 'UPCOMING'`
    )
    .all(competition.id);

  const teamIds = allClubs.map((club) => club.id);
  const standingsMap = buildLeagueStandings(playedMatches, teamIds);
  const standings = allClubs
    .map((club) => {
      const stat = standingsMap.get(club.id) || {
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        gf: 0,
        ga: 0,
        points: 0
      };
      return {
        club_id: club.id,
        club_name: club.name,
        ...stat,
        gd: stat.gf - stat.ga
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return a.club_name.localeCompare(b.club_name, "cs");
    });

  const roundsMap = new Map();
  for (const match of matches) {
    const roundNumber = Number(match.round_number || 1);
    if (!roundsMap.has(roundNumber)) {
      roundsMap.set(roundNumber, []);
    }
    roundsMap.get(roundNumber).push(match);
  }

  const rounds = Array.from(roundsMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([roundNumber, roundMatches]) => ({
      roundNumber,
      matches: roundMatches
    }));

  const maxCupRound = rounds.length > 0 ? rounds[rounds.length - 1].roundNumber : 1;
  const cupBracketRounds = rounds.map((round) => ({
    ...round,
    label: getCupRoundLabel(round.roundNumber, maxCupRound)
  }));

  res.render("competition-dashboard", {
    competition,
    isCup,
    matches,
    allClubs,
    standings,
    rounds,
    cupBracketRounds
  });
});

app.post("/competition/matches/create", requireCompetition, (req, res) => {
  const { home_club_id, away_club_id, home_score, away_score, kickoff, status, round_number } = req.body;
  const competition = db.prepare("SELECT id, name FROM competitions WHERE id = ?").get(req.session.competitionId);

  if (!competition) {
    return res.status(403).redirect("/competition");
  }

  const homeClubId = Number(home_club_id);
  const awayClubId = Number(away_club_id);
  if (homeClubId === awayClubId) {
    return res.status(400).redirect("/competition");
  }

  const allowedTeams = db
    .prepare("SELECT club_id FROM competition_teams WHERE competition_id = ?")
    .all(competition.id)
    .map((row) => row.club_id);

  if (!allowedTeams.includes(homeClubId) || !allowedTeams.includes(awayClubId)) {
    return res.status(403).redirect("/competition");
  }

  db.prepare(
    `INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status, round_number, created_by_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    competition.name,
    competition.id,
    homeClubId,
    awayClubId,
    Number(home_score),
    Number(away_score),
    kickoff,
    status,
    Math.max(1, Number(round_number) || 1)
  );

  res.redirect("/competition");
});

app.get("/club/login", (req, res) => {
  if (req.session.clubId) {
    return res.redirect("/club");
  }
  res.render("club-login", { error: null });
});

app.post("/club/login", (req, res) => {
  const { username, password } = req.body;
  const club = db.prepare("SELECT * FROM clubs WHERE login_username = ?").get(username);

  if (club && passwordMatches(password, club.login_password)) {
    req.session.clubId = club.id;
    req.session.clubName = club.name;
    return res.redirect("/club");
  }

  return res.status(401).render("club-login", { error: "Neplatne klubove prihlaseni." });
});

app.post("/club/logout", requireClub, (req, res) => {
  delete req.session.clubId;
  delete req.session.clubName;
  res.redirect("/");
});

app.get("/club", requireClub, (req, res) => {
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(req.session.clubId);

  if (!club) {
    delete req.session.clubId;
    delete req.session.clubName;
    return res.redirect("/club/login");
  }

  const players = db.prepare("SELECT * FROM players WHERE club_id = ? ORDER BY full_name ASC").all(club.id);
  const competitions = db
    .prepare(
      `SELECT cmp.*
       FROM competition_teams ct
       JOIN competitions cmp ON cmp.id = ct.competition_id
       WHERE ct.club_id = ?
       ORDER BY cmp.name ASC`
    )
    .all(club.id);
  const allClubs = db.prepare("SELECT * FROM clubs WHERE id != ? ORDER BY name ASC").all(club.id);
  const matches = db
    .prepare(
      `SELECT m.*, COALESCE(cmp.name, m.competition) AS competition_name,
              h.name AS home_name, a.name AS away_name
       FROM matches m
       LEFT JOIN competitions cmp ON cmp.id = m.competition_id
       JOIN clubs h ON h.id = m.home_club_id
       JOIN clubs a ON a.id = m.away_club_id
       WHERE m.home_club_id = ? OR m.away_club_id = ?
       ORDER BY m.kickoff DESC`
    )
    .all(club.id, club.id);

  const transfers = db
    .prepare(
      `SELECT t.*, p.full_name AS player_name, c_from.name AS from_name, c_to.name AS to_name
       FROM transfers t
       JOIN players p ON p.id = t.player_id
       LEFT JOIN clubs c_from ON c_from.id = t.from_club_id
       LEFT JOIN clubs c_to ON c_to.id = t.to_club_id
       WHERE t.from_club_id = ? OR t.to_club_id = ?
       ORDER BY t.transfer_date DESC`
    )
    .all(club.id, club.id);

  res.render("club-dashboard", { club, players, matches, transfers, competitions, allClubs });
});

// ===== REFEREE ROUTES =====

app.get("/referee/login", (req, res) => {
  if (req.session.refereeId) {
    return res.redirect("/referee");
  }
  res.render("referee-login", { error: null });
});

app.post("/referee/login", (req, res) => {
  const { username, password } = req.body;
  const referee = db.prepare("SELECT * FROM referees WHERE login_username = ?").get(username);

  if (referee && passwordMatches(password, referee.login_password)) {
    req.session.refereeId = referee.id;
    req.session.refereeName = referee.name;
    return res.redirect("/referee");
  }

  return res.status(401).render("referee-login", { error: "Neplatne rozhodci prihlaseni." });
});

app.post("/referee/logout", requireReferee, (req, res) => {
  delete req.session.refereeId;
  delete req.session.refereeName;
  res.redirect("/");
});

app.get("/referee", requireReferee, (req, res) => {
  const referee = db.prepare("SELECT * FROM referees WHERE id = ?").get(req.session.refereeId);

  if (!referee) {
    delete req.session.refereeId;
    delete req.session.refereeName;
    return res.redirect("/referee/login");
  }

  const matches = db
    .prepare(
      `SELECT m.*, h.name AS home_name, a.name AS away_name, COALESCE(cmp.name, m.competition) AS competition_name
       FROM matches m
       LEFT JOIN competitions cmp ON cmp.id = m.competition_id
       JOIN clubs h ON h.id = m.home_club_id
       JOIN clubs a ON a.id = m.away_club_id
       WHERE m.referee_id = ? AND m.match_closed = 0
       ORDER BY m.kickoff DESC`
    )
    .all(req.session.refereeId);

  res.render("referee-dashboard", { referee, matches });
});

app.post("/referee/matches/:id/update", requireReferee, (req, res) => {
  const { home_score, away_score, status } = req.body;
  const match = db.prepare("SELECT * FROM matches WHERE id = ? AND referee_id = ? AND match_closed = 0").get(
    req.params.id,
    req.session.refereeId
  );

  if (!match) {
    return res.status(403).redirect("/referee");
  }

  db.prepare("UPDATE matches SET home_score = ?, away_score = ?, status = ? WHERE id = ?").run(
    Number(home_score),
    Number(away_score),
    status,
    req.params.id
  );

  if (match.competition_id) {
    tryAdvanceCupCompetition(match.competition_id);
  }

  res.redirect("/referee");
});

app.post("/referee/matches/:id/close", requireReferee, (req, res) => {
  const match = db.prepare("SELECT * FROM matches WHERE id = ? AND referee_id = ? AND match_closed = 0").get(
    req.params.id,
    req.session.refereeId
  );

  if (!match) {
    return res.status(403).redirect("/referee");
  }

  db.prepare("UPDATE matches SET match_closed = 1, status = 'FT' WHERE id = ?").run(req.params.id);

  if (match.competition_id) {
    tryAdvanceCupCompetition(match.competition_id);
  }

  res.redirect("/referee");
});

// ===== MESSAGING SYSTEM =====

app.get("/club/messages", requireClub, (req, res) => {
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(req.session.clubId);

  if (!club) {
    delete req.session.clubId;
    delete req.session.clubName;
    return res.redirect("/club/login");
  }

  const clubs = db.prepare("SELECT * FROM clubs WHERE id != ? ORDER BY name ASC").all(req.session.clubId);
  const players = db.prepare("SELECT * FROM players WHERE club_id = ? ORDER BY full_name ASC").all(req.session.clubId);

  const incomingMessages = db
    .prepare(
      `SELECT m.*, c_from.name AS from_club_name, p.full_name AS player_name
       FROM messages m
       JOIN clubs c_from ON c_from.id = m.from_club_id
       LEFT JOIN players p ON p.id = m.player_id
       WHERE m.to_club_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(req.session.clubId);

  const outgoingMessages = db
    .prepare(
      `SELECT m.*, c_to.name AS to_club_name, p.full_name AS player_name
       FROM messages m
       JOIN clubs c_to ON c_to.id = m.to_club_id
       LEFT JOIN players p ON p.id = m.player_id
       WHERE m.from_club_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(req.session.clubId);

  res.render("club-messages", { club, clubs, players, incomingMessages, outgoingMessages });
});

app.post("/club/message/send", requireClub, (req, res) => {
  const { to_club_id, player_id, message } = req.body;

  if (!to_club_id || !message) {
    return res.redirect("/club/messages");
  }

  const toClubId = Number(to_club_id);
  const playerId = player_id ? Number(player_id) : null;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO messages (from_club_id, to_club_id, player_id, message, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'unread')`
  ).run(req.session.clubId, toClubId, playerId, message, now);

  res.redirect("/club/messages");
});

app.post("/club/message/:id/mark-read", requireClub, (req, res) => {
  const messageId = Number(req.params.id);
  
  db.prepare("UPDATE messages SET status = 'read' WHERE id = ? AND to_club_id = ?").run(
    messageId,
    req.session.clubId
  );

  res.redirect("/club/messages");
});

app.post("/club/message/:id/delete", requireClub, (req, res) => {
  const messageId = Number(req.params.id);
  
  db.prepare(
    "DELETE FROM messages WHERE id = ? AND (from_club_id = ? OR to_club_id = ?)"
  ).run(messageId, req.session.clubId, req.session.clubId);

  res.redirect("/club/messages");
});

// ===== MATCH MAKING SYSTEM =====

app.post("/admin/competitions/:id/generate-matches", requireAdmin, (req, res) => {
  const competitionId = Number(req.params.id);
  const competition = db.prepare("SELECT * FROM competitions WHERE id = ?").get(competitionId);

  if (!competition) {
    return res.redirect("/admin");
  }

  const teams = db
    .prepare("SELECT club_id FROM competition_teams WHERE competition_id = ? ORDER BY club_id ASC")
    .all(competitionId)
    .map(t => t.club_id);

  if (teams.length < 2) {
    return res.redirect("/admin");
  }

  db.transaction(() => {
    if (competition.format === "cup") {
      db.prepare("DELETE FROM matches WHERE competition_id = ?").run(competitionId);
    } else {
      db.prepare("DELETE FROM matches WHERE competition_id = ? AND status = 'UPCOMING'").run(competitionId);
    }

    const now = new Date();
    let matchDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    if (competition.format === "cup") {
      const cupLegs = normalizeCupLegs(competition.cup_legs);
      insertCupRoundMatches(competition, competitionId, [...teams], 1, matchDate, cupLegs);
      return;
    }

    const rounds = buildRoundRobinRounds(teams, false);
    rounds.forEach((roundMatches, index) => {
      const roundNumber = index + 1;
      roundMatches.forEach((pair, pairIndex) => {
        const kickoff = new Date(matchDate.getTime() + pairIndex * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ");

        db.prepare(
          `INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status, round_number, created_by_admin)
           VALUES (?, ?, ?, ?, 0, 0, ?, 'UPCOMING', ?, 1)`
        ).run(competition.name, competitionId, pair.home, pair.away, kickoff, roundNumber);
      });

      matchDate.setDate(matchDate.getDate() + 7);
    });
  })();

  res.redirect("/admin");
});

app.post("/admin/competitions/:id/shuffle-matches", requireAdmin, (req, res) => {
  const competitionId = Number(req.params.id);
  const competition = db.prepare("SELECT * FROM competitions WHERE id = ?").get(competitionId);

  if (!competition) {
    return res.redirect("/admin");
  }

  const teams = db
    .prepare("SELECT club_id FROM competition_teams WHERE competition_id = ? ORDER BY club_id ASC")
    .all(competitionId)
    .map(t => t.club_id);

  if (teams.length < 2) {
    return res.redirect("/admin");
  }

  db.transaction(() => {
    if (competition.format === "cup") {
      db.prepare("DELETE FROM matches WHERE competition_id = ?").run(competitionId);
    } else {
      db.prepare("DELETE FROM matches WHERE competition_id = ? AND status = 'UPCOMING'").run(competitionId);
    }

    const now = new Date();
    let matchDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    if (competition.format === "cup") {
      const cupLegs = normalizeCupLegs(competition.cup_legs);
      const shuffledTeams = shuffleArray(teams);
      insertCupRoundMatches(competition, competitionId, shuffledTeams, 1, matchDate, cupLegs);
      return;
    }

    // League slosovani with rounds (kola)
    const rounds = buildRoundRobinRounds(teams, true);
    rounds.forEach((roundMatches, index) => {
      const roundNumber = index + 1;
      roundMatches.forEach((pair, pairIndex) => {
        const kickoff = new Date(matchDate.getTime() + pairIndex * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ");

        db.prepare(
          `INSERT INTO matches (competition, competition_id, home_club_id, away_club_id, home_score, away_score, kickoff, status, round_number, created_by_admin)
           VALUES (?, ?, ?, ?, 0, 0, ?, 'UPCOMING', ?, 1)`
        ).run(competition.name, competitionId, pair.home, pair.away, kickoff, roundNumber);
      });

      matchDate.setDate(matchDate.getDate() + 7);
    });
  })();

  res.redirect("/admin");
});

app.post("/admin/referees/create", requireAdmin, (req, res) => {
  const { name, login_username, login_password } = req.body;

  const username = parseNullable(login_username);
  const password = parseNullable(login_password);
  const passwordValue = password ? bcrypt.hashSync(password, 10) : null;

  if (!username || !passwordValue) {
    return res.redirect("/admin");
  }

  db.prepare("INSERT INTO referees (name, login_username, login_password) VALUES (?, ?, ?)").run(
    name,
    username,
    passwordValue
  );

  res.redirect("/admin");
});

app.post("/admin/referees/:id/update", requireAdmin, (req, res) => {
  const { name, login_password } = req.body;
  const existing = db.prepare("SELECT login_password FROM referees WHERE id = ?").get(req.params.id);
  const password = parseNullable(login_password);
  const nextPassword = password ? bcrypt.hashSync(password, 10) : existing.login_password;

  db.prepare("UPDATE referees SET name = ?, login_password = ? WHERE id = ?").run(
    name,
    nextPassword,
    req.params.id
  );

  res.redirect("/admin");
});

app.post("/admin/referees/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM referees WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

app.post("/admin/matches/:id/assign-referee", requireAdmin, (req, res) => {
  const { referee_id } = req.body;
  const match = db.prepare("SELECT * FROM matches WHERE id = ?").get(req.params.id);

  if (!match) {
    return res.redirect("/admin");
  }

  db.prepare("UPDATE matches SET referee_id = ? WHERE id = ?").run(
    referee_id ? Number(referee_id) : null,
    req.params.id
  );

  res.redirect("/admin");
});

app.post("/admin/matches/:id/update-score", requireAdmin, (req, res) => {
  const { home_score, away_score, status } = req.body;
  const match = db.prepare("SELECT * FROM matches WHERE id = ?").get(req.params.id);

  if (!match) {
    return res.redirect("/admin");
  }

  db.prepare("UPDATE matches SET home_score = ?, away_score = ?, status = ? WHERE id = ?").run(
    Number(home_score),
    Number(away_score),
    status,
    req.params.id
  );

  if (match.competition_id) {
    tryAdvanceCupCompetition(match.competition_id);
  }

  res.redirect("/admin");
});

app.use((req, res) => {
  res.status(404).render("not-found", { message: "Stranka nebyla nalezena." });
});

app.listen(port, () => {
  console.log(`Server bezi na http://localhost:${port}`);
});

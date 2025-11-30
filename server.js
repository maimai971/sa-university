const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'change_this_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24*60*60*1000 }
}));

// DB (sqlite)
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    displayname TEXT,
    password TEXT,
    role TEXT DEFAULT 'student'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS timetable (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jour TEXT, horaire TEXT, matiere TEXT, enseignant TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, matiere TEXT, note REAL, coefficient REAL DEFAULT 1, auteur_id INTEGER, attachment TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS diplomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, titre TEXT, moyenne REAL, date_obtention TEXT, attachment TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, contenu TEXT, date TEXT
  )`);
});

// Upload setup
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) { cb(null, uuidv4() + path.extname(file.originalname)); }
});
const upload = multer({ storage });

// expose user to views
app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });

// Helpers
function ensureLogged(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function ensureAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).send('Accès refusé');
  next();
}

// One-time setup route: create first admin if no users
app.get('/setup', (req, res) => {
  db.get("SELECT COUNT(*) as c FROM users", [], (err, row) => {
    if (row && row.c > 0) return res.send('Setup déjà effectué.');
    res.render('setup');
  });
});
app.post('/setup', async (req, res) => {
  const { username, displayname, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (username, displayname, password, role) VALUES (?, ?, ?, 'admin')",
    [username, displayname || username, hash], function(err) {
      if (err) return res.send('Erreur: ' + err.message);
      res.render('setup_done', { username, password });
  });
});

// Auth
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err) return res.render('login', { error: 'Erreur serveur' });
    if (!user) return res.render('login', { error: 'Utilisateur introuvable' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'Mot de passe incorrect' });
    req.session.user = { id: user.id, username: user.username, displayname: user.displayname, role: user.role };
    res.redirect('/dashboard');
  });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Dashboard
app.get('/', ensureLogged, (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', ensureLogged, (req, res) => res.render('dashboard'));

// Timetable (admin editable)
app.get('/timetable', ensureLogged, (req, res) => {
  db.all("SELECT * FROM timetable ORDER BY id ASC", [], (err, rows) => res.render('timetable', { emploi: rows }));
});
app.post('/timetable', ensureAdmin, (req, res) => {
  const { jour, horaire, matiere, enseignant } = req.body;
  db.run("INSERT INTO timetable (jour, horaire, matiere, enseignant) VALUES (?, ?, ?, ?)", [jour, horaire, matiere, enseignant], () => res.redirect('/timetable'));
});
app.post('/timetable/delete', ensureAdmin, (req, res) => {
  db.run("DELETE FROM timetable WHERE id = ?", [req.body.id], () => res.redirect('/timetable'));
});

// Notes (teachers/admins can add, attachments allowed)
app.get('/notes', ensureLogged, (req, res) => {
  if (res.locals.user.role === 'student') {
    db.all("SELECT * FROM notes WHERE user_id = ?", [res.locals.user.id], (err, rows) => res.render('notes', { notes: rows }));
  } else {
    db.all("SELECT n.*, u.displayname as eleve, a.displayname as auteur FROM notes n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN users a ON a.id = n.auteur_id ORDER BY n.id DESC", [], (err, rows) => res.render('notes', { notes: rows }));
  }
});
app.post('/notes', ensureAdmin, upload.single('attachment'), (req, res) => {
  const { user_id, matiere, note, coefficient } = req.body;
  const attachment = req.file ? ('/uploads/' + req.file.filename) : null;
  db.run("INSERT INTO notes (user_id, matiere, note, coefficient, auteur_id, attachment) VALUES (?, ?, ?, ?, ?, ?)",
    [user_id, matiere, note, coefficient || 1, res.locals.user.id, attachment], () => res.redirect('/notes'));
});
app.post('/notes/delete', ensureAdmin, (req, res) => {
  db.get("SELECT attachment FROM notes WHERE id = ?", [req.body.id], (err, row) => {
    if (row && row.attachment) {
      const p = path.join(__dirname, 'public', row.attachment);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    db.run("DELETE FROM notes WHERE id = ?", [req.body.id], () => res.redirect('/notes'));
  });
});

// Diplomas (admin can generate and attach file)
app.get('/diplomes', ensureLogged, (req, res) => {
  db.all("SELECT d.*, u.displayname FROM diplomes d LEFT JOIN users u ON u.id = d.user_id WHERE d.user_id = ? OR ? = 1", [res.locals.user.id, res.locals.user.role === 'admin' ? 1 : 0], (err, rows) => res.render('diplomes', { diplomes: rows }));
});
app.post('/diplomes', ensureAdmin, upload.single('attachment'), (req, res) => {
  const { user_id, titre } = req.body;
  db.all("SELECT note, coefficient FROM notes WHERE user_id = ?", [user_id], (err, rows) => {
    let s=0,c=0; rows.forEach(r => { s += r.note * (r.coefficient || 1); c += (r.coefficient || 1); });
    const moyenne = c ? (s/c) : 0;
    const attachment = req.file ? ('/uploads/' + req.file.filename) : null;
    db.run("INSERT INTO diplomes (user_id, titre, moyenne, date_obtention, attachment) VALUES (?, ?, ?, datetime('now'), ?)", [user_id, titre || 'Diplôme RP', moyenne, attachment], () => res.redirect('/diplomes'));
  });
});
app.post('/diplomes/delete', ensureAdmin, (req, res) => {
  db.get("SELECT attachment FROM diplomes WHERE id = ?", [req.body.id], (err, row) => {
    if (row && row.attachment) {
      const p = path.join(__dirname, 'public', row.attachment);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    db.run("DELETE FROM diplomes WHERE id = ?", [req.body.id], () => res.redirect('/diplomes'));
  });
});

// Messages (persisted + real-time)
app.get('/messages', ensureLogged, (req, res) => {
  db.all("SELECT m.*, u.displayname FROM messages m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC", [], (err, rows) => res.render('messages', { messages: rows }));
});
app.post('/messages', ensureLogged, (req, res) => {
  db.run("INSERT INTO messages (user_id, contenu, date) VALUES (?, ?, datetime('now'))", [res.locals.user.id, req.body.contenu], function() {
    db.all("SELECT m.*, u.displayname FROM messages m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC", [], (err, rows) => {
      io.emit('messages_update', rows);
      res.redirect('/messages');
    });
  });
});

// socket.io for live chat (client should connect and emit 'chat_message')
io.on('connection', socket => {
  socket.on('chat_message', data => {
    // broadcast message to all
    io.emit('chat_message', data);
  });
});

// Admin users management routes
app.get('/admin/users', ensureAdmin, (req, res) => {
  db.all("SELECT id, username, displayname, role FROM users ORDER BY id ASC", [], (err, rows) => res.render('admin_users', { users: rows, created: null }));
});
app.post('/admin/users/create', ensureAdmin, async (req, res) => {
  let { username, displayname, password, role } = req.body;
  if (!password || password.trim() === '') { password = uuidv4().split('-')[0]; }
  const hash = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (username, displayname, password, role) VALUES (?, ?, ?, ?)", [username, displayname||username, hash, role], function(err) {
    if (err) return res.status(500).send('Erreur création utilisateur: ' + err.message);
    db.all("SELECT id, username, displayname, role FROM users ORDER BY id ASC", [], (err2, rows) => {
      res.render('admin_users', { users: rows, created: { username, password, role } });
    });
  });
});
app.post('/admin/users/delete', ensureAdmin, (req, res) => {
  db.run("DELETE FROM users WHERE id = ?", [req.body.id], () => res.redirect('/admin/users'));
});
app.post('/admin/users/reset', ensureAdmin, async (req, res) => {
  const id = req.body.id;
  const newPw = uuidv4().split('-')[0];
  const hash = await bcrypt.hash(newPw, 10);
  db.run("UPDATE users SET password = ? WHERE id = ?", [hash, id], function() {
    db.get("SELECT username FROM users WHERE id = ?", [id], (err, row) => {
      db.all("SELECT id, username, displayname, role FROM users ORDER BY id ASC", [], (err2, rows) => {
        res.render('admin_users', { users: rows, created: { username: row.username, password: newPw, role: null } });
      });
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));

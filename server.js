const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
if (isProd && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random string of at least 32 characters in production.');
}
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'kamand-chat.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('direct','group')),
 title TEXT, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
 conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 joined_at TEXT NOT NULL DEFAULT (datetime('now')), last_read_id INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 edited_at TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS reactions (
 message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL,
 PRIMARY KEY(message_id,user_id,emoji)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id,conversation_id);
`);
// Safe migration for databases created before profile bios were supported.
if (!db.prepare('PRAGMA table_info(users)').all().some(col => col.name === 'bio')) {
  db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
}
const SQLiteStore = SQLiteStoreFactory(session);
const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir, table: 'sessions' }),
  secret: sessionSecret || 'development-only-change-this-secret-before-deployment',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 14 }
});
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const requireAuth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const safeUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio || '' });
const getUser = id => db.prepare('SELECT id, username, display_name, bio FROM users WHERE id=?').get(id);
const isMember = (conversationId, userId) => !!db.prepare('SELECT 1 FROM memberships WHERE conversation_id=? AND user_id=?').get(conversationId, userId);
const getConversation = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
const userSockets = new Map();
const onlineIds = () => [...userSockets.keys()].map(Number);
function conversationPayload(c, userId) {
  const members = db.prepare(`SELECT u.id,u.username,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? ORDER BY u.display_name`).all(c.id);
  const last = db.prepare(`SELECT id,body,created_at,sender_id,deleted_at FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(c.id);
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND id>(SELECT last_read_id FROM memberships WHERE conversation_id=? AND user_id=?) AND sender_id<>? AND deleted_at IS NULL`).get(c.id,c.id,userId,userId).n;
  let title = c.title;
  if (c.type === 'direct') title = members.find(m => m.id !== userId)?.display_name || 'Direct message';
  return { id:c.id, type:c.type, title, members:members.map(m=>({id:m.id,username:m.username,displayName:m.display_name})), lastMessage:last ? { id:last.id, body:last.deleted_at?'Message deleted':last.body, createdAt:last.created_at, senderId:last.sender_id } : null, unread };
}
function sendToConversation(conversationId, event, payload) { io.to(`conversation:${conversationId}`).emit(event, payload); }
function joinUserRooms(socket, userId) {
  socket.join(`user:${userId}`);
  db.prepare('SELECT conversation_id FROM memberships WHERE user_id=?').all(userId).forEach(r=>socket.join(`conversation:${r.conversation_id}`));
}
io.engine.use(sessionMiddleware);
io.use((socket,next)=>{
  const userId=socket.request.session?.userId;
  if(!userId || !getUser(userId)) return next(new Error('Authentication required'));
  socket.userId=Number(userId); next();
});
io.on('connection', socket => {
  const uid=socket.userId;
  const count=userSockets.get(uid)||0; userSockets.set(uid,count+1);
  joinUserRooms(socket,uid);
  if(count===0) io.emit('presence:update',{userId:uid,online:true});
  socket.on('conversation:join', ({conversationId}={})=>{
    const id=Number(conversationId); if(Number.isInteger(id)&&isMember(id,uid)) socket.join(`conversation:${id}`);
  });
  socket.on('message:send', ({conversationId,body}={}, ack=()=>{})=>{
    const id=Number(conversationId); const text=typeof body==='string'?body.trim():'';
    if(!Number.isInteger(id)||!isMember(id,uid)) return ack({error:'You are not a member of this conversation.'});
    if(!text||text.length>4000) return ack({error:'Messages must contain 1–4,000 characters.'});
    const info=db.prepare('INSERT INTO messages(conversation_id,sender_id,body) VALUES(?,?,?)').run(id,uid,text);
    const msg=db.prepare(`SELECT m.id,m.conversation_id,m.sender_id,m.body,m.created_at,m.edited_at,m.deleted_at,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?`).get(info.lastInsertRowid);
    const payload={id:msg.id,conversationId:msg.conversation_id,senderId:msg.sender_id,body:msg.body,createdAt:msg.created_at,editedAt:msg.edited_at,deletedAt:msg.deleted_at,sender:{id:uid,username:msg.username,displayName:msg.display_name},reactions:[]};
    sendToConversation(id,'message:new',payload); io.to(`conversation:${id}`).emit('conversation:updated',{conversationId:id}); ack({ok:true,message:payload});
  });
  socket.on('typing:set', ({conversationId,typing}={})=>{const id=Number(conversationId);if(isMember(id,uid))socket.to(`conversation:${id}`).emit('typing:update',{conversationId:id,userId:uid,displayName:getUser(uid).display_name,typing:!!typing});});
  socket.on('message:read', ({conversationId,lastMessageId}={})=>{const id=Number(conversationId), mid=Number(lastMessageId);if(!isMember(id,uid)||!Number.isInteger(mid))return;db.prepare('UPDATE memberships SET last_read_id=MAX(last_read_id,?) WHERE conversation_id=? AND user_id=?').run(mid,id,uid);socket.to(`conversation:${id}`).emit('receipt:read',{conversationId:id,userId:uid,lastMessageId:mid});});
  socket.on('message:edit', ({messageId,body}={},ack=()=>{})=>{const mid=Number(messageId),text=typeof body==='string'?body.trim():'';const msg=db.prepare('SELECT * FROM messages WHERE id=?').get(mid);if(!msg||msg.sender_id!==uid||msg.deleted_at||!text||text.length>4000)return ack({error:'This message cannot be edited.'});db.prepare("UPDATE messages SET body=?,edited_at=datetime('now') WHERE id=?").run(text,mid);sendToConversation(msg.conversation_id,'message:changed',{id:mid,body:text,editedAt:new Date().toISOString()});ack({ok:true});});
  socket.on('message:delete', ({messageId}={},ack=()=>{})=>{const mid=Number(messageId),msg=db.prepare('SELECT * FROM messages WHERE id=?').get(mid);if(!msg||msg.sender_id!==uid||msg.deleted_at)return ack({error:'This message cannot be deleted.'});db.prepare("UPDATE messages SET body='',deleted_at=datetime('now') WHERE id=?").run(mid);sendToConversation(msg.conversation_id,'message:changed',{id:mid,body:'',deletedAt:new Date().toISOString()});ack({ok:true});});
  socket.on('reaction:toggle', ({messageId,emoji}={},ack=()=>{})=>{const mid=Number(messageId),e=typeof emoji==='string'?emoji.slice(0,12):'';const msg=db.prepare('SELECT * FROM messages WHERE id=?').get(mid);if(!msg||!isMember(msg.conversation_id,uid)||!['👍','❤️','😂','🎉','😮','👀','🔥','🥳','🙏','💯','🤔','😍'].includes(e))return ack({error:'Invalid reaction.'});const exists=db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').get(mid,uid,e);if(exists)db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(mid,uid,e);else db.prepare('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)').run(mid,uid,e);const reactions=db.prepare('SELECT emoji,COUNT(*) AS count,GROUP_CONCAT(user_id) AS users FROM reactions WHERE message_id=? GROUP BY emoji').all(mid).map(r=>({emoji:r.emoji,count:r.count,users:r.users.split(',').map(Number)}));sendToConversation(msg.conversation_id,'reaction:changed',{messageId:mid,reactions});ack({ok:true});});
  socket.on('disconnect',()=>{const n=(userSockets.get(uid)||1)-1;if(n<=0){userSockets.delete(uid);io.emit('presence:update',{userId:uid,online:false});}else userSockets.set(uid,n);});
});

app.get('/api/me',(req,res)=>{if(!req.session.userId)return res.json({user:null});const u=getUser(req.session.userId);res.json({user:u?safeUser(u):null});});
app.post('/api/auth/register',authLimiter,async(req,res)=>{const username=String(req.body.username||'').trim().toLowerCase();const displayName=String(req.body.displayName||'').trim();const password=String(req.body.password||'');if(!/^[a-z0-9_]{3,20}$/.test(username))return res.status(400).json({error:'Username must be 3–20 characters (letters, numbers, underscores).'});if(displayName.length<2||displayName.length>40)return res.status(400).json({error:'Display name must be 2–40 characters.'});if(password.length<8||password.length>72)return res.status(400).json({error:'Password must be 8–72 characters.'});try{const hash=await bcrypt.hash(password,12);const info=db.prepare('INSERT INTO users(username,display_name,password_hash) VALUES(?,?,?)').run(username,displayName,hash);req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not create session.'});req.session.userId=Number(info.lastInsertRowid);req.session.save(err2=>err2?res.status(500).json({error:'Could not save session.'}):res.json({user:safeUser(getUser(info.lastInsertRowid))}));});}catch(e){if(String(e.code)==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'That username is already taken.'});res.status(500).json({error:'Registration failed.'});}});
app.post('/api/auth/login',authLimiter,async(req,res)=>{const username=String(req.body.username||'').trim().toLowerCase();const password=String(req.body.password||'');const u=db.prepare('SELECT * FROM users WHERE username=?').get(username);if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Incorrect username or password.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not create session.'});req.session.userId=u.id;req.session.save(err2=>err2?res.status(500).json({error:'Could not save session.'}):res.json({user:safeUser(u)}));});});
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('connect.sid');res.json({ok:true});}));
app.patch('/api/profile',requireAuth,(req,res)=>{const displayName=String(req.body.displayName||'').trim();const bio=String(req.body.bio||'').trim();if(displayName.length<2||displayName.length>40)return res.status(400).json({error:'Display name must be 2–40 characters.'});if(bio.length>160)return res.status(400).json({error:'Bio must be 160 characters or fewer.'});db.prepare('UPDATE users SET display_name=?,bio=? WHERE id=?').run(displayName,bio,req.session.userId);const user=safeUser(getUser(req.session.userId));io.emit('profile:updated',{user});res.json({user});});
app.get('/api/users',requireAuth,(req,res)=>{const q=String(req.query.q||'').trim().slice(0,50);const users=db.prepare(`SELECT id,username,display_name FROM users WHERE id<>? AND (username LIKE ? OR display_name LIKE ?) ORDER BY display_name LIMIT 40`).all(req.session.userId,`%${q}%`,`%${q}%`);res.json({users:users.map(safeUser),online:onlineIds()});});
app.get('/api/conversations',requireAuth,(req,res)=>{const rows=db.prepare('SELECT c.* FROM conversations c JOIN memberships m ON m.conversation_id=c.id WHERE m.user_id=? ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=c.id),0) DESC,c.id DESC').all(req.session.userId);res.json({conversations:rows.map(c=>conversationPayload(c,req.session.userId))});});
app.post('/api/conversations/direct',requireAuth,(req,res)=>{const other=Number(req.body.userId),me=req.session.userId;if(!Number.isInteger(other)||other===me||!getUser(other))return res.status(400).json({error:'Choose a valid user.'});let c=db.prepare(`SELECT c.* FROM conversations c JOIN memberships a ON a.conversation_id=c.id AND a.user_id=? JOIN memberships b ON b.conversation_id=c.id AND b.user_id=? WHERE c.type='direct' AND (SELECT COUNT(*) FROM memberships x WHERE x.conversation_id=c.id)=2`).get(me,other);if(!c){const create=db.transaction(()=>{const x=db.prepare("INSERT INTO conversations(type,created_by) VALUES('direct',?)").run(me);const id=Number(x.lastInsertRowid);const ins=db.prepare('INSERT INTO memberships(conversation_id,user_id) VALUES(?,?)');ins.run(id,me);ins.run(id,other);return getConversation(id);});c=create();}for(const id of [me,other])io.to(`user:${id}`).emit('conversations:refresh');res.json({conversation:conversationPayload(c,me)});});
app.post('/api/conversations/group',requireAuth,(req,res)=>{const title=String(req.body.title||'').trim();const ids=[...new Set((Array.isArray(req.body.userIds)?req.body.userIds:[]).map(Number).filter(Number.isInteger))].filter(id=>id!==req.session.userId);if(title.length<2||title.length>60)return res.status(400).json({error:'Group name must be 2–60 characters.'});if(ids.length<1||ids.length>30)return res.status(400).json({error:'Choose between 1 and 30 other members.'});if(ids.some(id=>!getUser(id)))return res.status(400).json({error:'One or more selected users do not exist.'});const c=db.transaction(()=>{const x=db.prepare("INSERT INTO conversations(type,title,created_by) VALUES('group',?,?)").run(title,req.session.userId);const cid=Number(x.lastInsertRowid),ins=db.prepare('INSERT INTO memberships(conversation_id,user_id) VALUES(?,?)');[req.session.userId,...ids].forEach(id=>ins.run(cid,id));return getConversation(cid);})();for(const id of [req.session.userId,...ids])io.to(`user:${id}`).emit('conversations:refresh');res.json({conversation:conversationPayload(c,req.session.userId)});});
app.get('/api/conversations/:id/messages',requireAuth,(req,res)=>{const id=Number(req.params.id);if(!Number.isInteger(id)||!isMember(id,req.session.userId))return res.status(404).json({error:'Conversation not found.'});const before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;const rows=db.prepare(`SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND m.id<? ORDER BY m.id DESC LIMIT 100`).all(id,before).reverse();const messages=rows.map(m=>({id:m.id,conversationId:m.conversation_id,senderId:m.sender_id,body:m.deleted_at?'':m.body,createdAt:m.created_at,editedAt:m.edited_at,deletedAt:m.deleted_at,sender:{id:m.sender_id,username:m.username,displayName:m.display_name},reactions:db.prepare('SELECT emoji,COUNT(*) AS count,GROUP_CONCAT(user_id) AS users FROM reactions WHERE message_id=? GROUP BY emoji').all(m.id).map(r=>({emoji:r.emoji,count:r.count,users:r.users.split(',').map(Number)}))}));if(messages.length){const last=messages[messages.length-1].id;db.prepare('UPDATE memberships SET last_read_id=MAX(last_read_id,?) WHERE conversation_id=? AND user_id=?').run(last,id,req.session.userId);}res.json({messages});});
app.get('/api/search',requireAuth,(req,res)=>{const q=String(req.query.q||'').trim().slice(0,100);if(q.length<2)return res.json({messages:[]});const messages=db.prepare(`SELECT m.id,m.conversation_id,m.sender_id,m.body,m.created_at,u.display_name FROM messages m JOIN users u ON u.id=m.sender_id JOIN memberships mine ON mine.conversation_id=m.conversation_id AND mine.user_id=? WHERE m.deleted_at IS NULL AND m.body LIKE ? ORDER BY m.id DESC LIMIT 50`).all(req.session.userId,`%${q}%`).map(m=>({id:m.id,conversationId:m.conversation_id,senderId:m.sender_id,body:m.body,createdAt:m.created_at,senderName:m.display_name}));res.json({messages});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(PORT,()=>console.log(`Kamand Chat running at http://localhost:${PORT}`));

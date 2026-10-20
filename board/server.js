const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const BOARDS_DIR = path.join(__dirname, 'boards');

if (!fs.existsSync(BOARDS_DIR)) {
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  let pathname = urlObj.pathname;

  // --- API: список досок ---
  if (pathname === '/api/boards') {
    try {
      const files = fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith('.json'));
      const boards = files.map(f => {
        const id = f.replace('.json', '');
        try {
          const stat = fs.statSync(path.join(BOARDS_DIR, f));
          const data = JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, f), 'utf8'));
          return {
            id: id,
            name: data.name || id,
            modified: stat.mtime.toISOString(),
            items: (data.history || []).length,
          };
        } catch {
          return { id, name: id, modified: null, items: 0 };
        }
      }).sort((a, b) => new Date(b.modified) - new Date(a.modified));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(boards));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- API: сохранить доску ---
  if (pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let { name, history, functions } = data;
        
        if (!name || !name.trim()) throw new Error('Введите название доски');
        
        const safeId = crypto.createHash('md5').update(name.trim()).digest('hex').slice(0, 10);
        
        const filePath = path.join(BOARDS_DIR, `${safeId}.json`);
        fs.writeFileSync(filePath, JSON.stringify({
          id: safeId,
          name: name.trim(),
          history: history || [],
          functions: functions || [],
          savedAt: new Date().toISOString(),
        }, null, 2));

        console.log(`💾 Сохранена доска: "${name}" (файл: ${safeId}.json)`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: safeId, name: name.trim() }));
      } catch (e) {
        console.error('Ошибка сохранения:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API: удалить доску ---
  if (pathname === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const safeId = (data.id || '').replace(/[^a-zA-Z0-9]/g, '');
        if (safeId) {
          const filePath = path.join(BOARDS_DIR, `${safeId}.json`);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Статика ---
  if (pathname === '/') pathname = '/index.html';
  const fullPath = path.join(__dirname, 'public', pathname);
  
  if (!fullPath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    const ext = path.extname(fullPath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ========== WebSocket ==========
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    let history = [], functions = [];
    const filePath = path.join(BOARDS_DIR, `${roomId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        history = data.history || [];
        functions = data.functions || [];
        console.log(`📂 Загружена доска "${data.name || roomId}" (${history.length} объектов)`);
      } catch (e) {
        console.error(`Ошибка чтения ${roomId}:`, e.message);
      }
    }
    rooms.set(roomId, { history, functions, clients: new Map() });
  }
  return rooms.get(roomId);
}

function broadcast(room, message, exclude = null) {
  const data = JSON.stringify(message);
  for (const ws of room.clients.keys()) {
    if (ws !== exclude && ws.readyState === 1) ws.send(data);
  }
}

function broadcastUsers(room) {
  const users = [...room.clients.values()].map(u => ({ id: u.id, color: u.color, name: u.name }));
  broadcast(room, { type: 'users', users });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = (url.searchParams.get('room') || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'default';
  const userId = (url.searchParams.get('userId') || 'u' + Math.random().toString(36).slice(2, 8)).slice(0, 50);
  const userColor = url.searchParams.get('color') || '#e94560';
  const userName = (url.searchParams.get('name') || 'Ученик').slice(0, 30);

  const room = getRoom(roomId);
  room.clients.set(ws, { id: userId, color: userColor, name: userName });

  ws.send(JSON.stringify({ type: 'history', history: room.history, functions: room.functions }));
  broadcastUsers(room);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'action') {
      if (msg.action.type === 'clear') {
        room.history = [];
        room.functions = [];
      } else if (msg.action.type === 'function') {
        room.functions.push({ expr: msg.action.expr, color: msg.action.color });
      } else if (msg.action.type === 'removeFunction') {
        room.functions = room.functions.filter((_, i) => i !== msg.action.index);
      } else {
        room.history.push(msg.action);
        if (room.history.length > 5000) room.history.shift();
      }
      broadcast(room, { type: 'action', action: msg.action, userId }, ws);
    }
    else if (msg.type === 'preview') {
      broadcast(room, { type: 'preview', action: msg.action }, ws);
    }
    else if (msg.type === 'updateObject') {
      if (room.history[msg.index]) {
        room.history[msg.index] = { ...room.history[msg.index], ...msg.obj };
      }
      broadcast(room, { type: 'updateObject', index: msg.index, obj: msg.obj }, ws);
    }
    else if (msg.type === 'updateMultipleObjects') {
      for (const update of msg.updates) {
        if (room.history[update.index]) {
          room.history[update.index] = { ...room.history[update.index], ...update.obj };
        }
      }
      broadcast(room, { type: 'updateMultipleObjects', updates: msg.updates }, ws);
    }
    else if (msg.type === 'deleteObjects') {
      const sortedIndices = [...msg.indices].sort((a, b) => b - a);
      for (const idx of sortedIndices) {
        if (room.history[idx]) room.history.splice(idx, 1);
      }
      broadcast(room, { type: 'deleteObjects', indices: sortedIndices }, ws);
    }
    else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcastUsers(room);
    if (room.clients.size === 0) {
      const filePath = path.join(BOARDS_DIR, `${roomId}.json`);
      if (!fs.existsSync(filePath)) rooms.delete(roomId);
    }
  });

  ws.on('error', () => room.clients.delete(ws));
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.clients.keys()) {
      if (ws.readyState === 1) ws.ping();
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`✅ MathBoard запущен на http://localhost:${PORT}`);
  console.log(`📁 Папка сохранений: ${BOARDS_DIR}`);
  const count = fs.existsSync(BOARDS_DIR) ? fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith('.json')).length : 0;
  console.log(`📚 Сохранённых досок: ${count}`);
});
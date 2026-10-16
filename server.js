/**
 * ==============================================================================
 * Product Management Server (Turso Database / SQLite)
 * Zero external npm dependencies required! Runs immediately with `node server.js`
 * ==============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'products.db');

// อ่านไฟล์ .env แบบ native (ไม่ต้องพึ่ง dotenv package)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

// ค่าคอนฟิก Turso
let TURSO_URL = process.env.TURSO_DATABASE_URL || 'libsql://kma-product-list-web-mstackhub.aws-ap-northeast-1.turso.io';
let TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTIxMjk1MTMsImlkIjoiMDFhMTQzM2UtMWYwMS03ZWFmLThmOGEtMDk5ZDU4YTFiY2VkIiwia2lkIjoiU1ZYRTc1Vy1QcHV4aWQ2RXJ6WlRRTzVNLW5OeVBzX0RjSm5qa0ZycXZ0YyIsInJpZCI6Ijc5NmMwNmVlLWJkY2EtNDRlYy1iYzEwLWJmOWI5ZmIzZjE5NSJ9.GEqIZaQPTvA9pvVCR5FDoAcekwdU5ijeOJGz0BsdV5ZRmoOxoajodxwgF30gD5agw0416Uaz4lU-t9ZyCqNLCg';

// แปลง libsql:// เป็น https:// สำหรับ HTTP pipeline
function normalizeTursoUrl(url) {
  if (!url) return '';
  let clean = url.trim();
  if (clean.startsWith('libsql://')) {
    clean = 'https://' + clean.slice('libsql://'.length);
  }
  return clean.replace(/\/+$/, '');
}

/**
 * ==============================================================================
 * Database Layer: Turso Cloud HTTP Pipeline & Local SQLite Fallback
 * ==============================================================================
 */

// Helper แปลง value ให้เป็น typed value ของ Turso pipeline
function toTursoArg(val) {
  if (val === null || val === undefined) return { type: 'null' };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { type: 'integer', value: String(val) } : { type: 'float', value: val };
  }
  return { type: 'text', value: String(val) };
}

// รันคำสั่ง SQL ผ่าน Turso HTTP Pipeline API
async function queryTurso(sql, args = []) {
  const baseUrl = normalizeTursoUrl(TURSO_URL);
  const endpoint = `${baseUrl}/v2/pipeline`;
  
  const typedArgs = args.map(toTursoArg);
  const body = {
    requests: [
      {
        type: 'execute',
        stmt: { sql, args: typedArgs }
      },
      { type: 'close' }
    ]
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Turso HTTP Error (${response.status}): ${errText}`);
  }

  const json = await response.json();
  const execResult = json.results?.[0]?.response?.result;
  if (!execResult) {
    if (json.results?.[0]?.error) {
      throw new Error(`Turso SQL Error: ${json.results[0].error.message}`);
    }
    return [];
  }

  const cols = execResult.cols.map(c => c.name);
  const rows = execResult.rows.map(row => {
    const obj = {};
    row.forEach((cell, idx) => {
      let val = cell.value;
      if (cell.type === 'integer' || cell.type === 'float') {
        val = Number(val);
      } else if (cell.type === 'null') {
        val = null;
      }
      obj[cols[idx]] = val;
    });
    return obj;
  });

  return rows;
}

// รันคำสั่ง SQL ผ่าน Local SQLite3 CLI (สำหรับ Offline หรือรันทันทีก่อนต่อ Cloud)
function queryLocalSqlite(sql, args = []) {
  // สร้างตารางหากยังไม่มี
  const initSql = `
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'ทั่วไป',
      original_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      image_url TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `;
  execSync(`sqlite3 "${DB_FILE}" "${initSql.replace(/"/g, '\\"')}"`);

  // ใส่ parameter แบบปลอดภัย
  let processedSql = sql;
  if (args.length > 0) {
    let argIdx = 0;
    processedSql = sql.replace(/\?/g, () => {
      const val = args[argIdx++];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return val;
      return `'${String(val).replace(/'/g, "''")}'`;
    });
  }

  // หากเป็น SELECT ให้ดึง JSON ออกมาด้วย -json flag ของ sqlite3
  const trimmed = processedSql.trim();
  if (/^SELECT/i.test(trimmed)) {
    try {
      const output = execSync(`sqlite3 -json "${DB_FILE}" "${processedSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
      if (!output) return [];
      return JSON.parse(output);
    } catch (e) {
      console.error('SQLite query error:', e.message);
      return [];
    }
  } else {
    // INSERT / UPDATE / DELETE
    execSync(`sqlite3 "${DB_FILE}" "${processedSql.replace(/"/g, '\\"')}"`);
    return [];
  }
}

// Database Router: เลือกใช้ Turso Cloud หากมี URL และ Token ไม่เช่นนั้นใช้ Local SQLite
async function executeDb(sql, args = []) {
  if (TURSO_URL && TURSO_TOKEN) {
    try {
      return await queryTurso(sql, args);
    } catch (err) {
      console.warn('⚠️ Turso cloud query failed, falling back to local SQLite:', err.message);
      return queryLocalSqlite(sql, args);
    }
  } else {
    return queryLocalSqlite(sql, args);
  }
}

// ตรวจสอบและสร้างโครงสร้างฐานข้อมูลเริ่มต้น พร้อมข้อมูลตัวอย่าง
async function initializeDatabase() {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'ทั่วไป',
      original_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      image_url TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `;
  await executeDb(createTableSql);

  // เช็คว่ามีสินค้าหรือยัง ถ้ายังไม่มีให้ใส่ตัวอย่าง
  const existing = await executeDb('SELECT id FROM products LIMIT 1');
  if (existing.length === 0) {
    console.log('📦 Seeding sample products...');
    const samples = [
      ['PRD-1001', 'KMA Water Resist Liquid Foundation', 'รองพื้น', 490, 399, 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=500&q=80', 'รองพื้นสูตรคุมมัน กันน้ำ กันเหงื่อ เนียนสนิทตลอดวัน'],
      ['PRD-1002', 'KMA Sheer Soft Loose Powder', 'แป้ง', 350, 280, 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=500&q=80', 'แป้งฝุ่นเนื้อละเอียด สัมผัสบางเบา คุมความมัน'],
      ['PRD-1003', 'KMA Glamour Velvet Lip Color', 'แต่งหน้า', 290, 199, 'https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=500&q=80', 'ลิปกำมะหยี่สีชัด ติดทนนาน ไม่ทำให้ปากแห้ง'],
      ['PRD-1004', 'KMA Perfect Brow Pencil Waterproof', 'แต่งหน้า, อุปกรณ์แต่งหน้า', 199, 149, 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=500&q=80', 'ดินสอเขียนคิ้วหัวสลิม วาดเส้นคิ้วสวยคมเป็นธรรมชาติ'],
      ['PRD-1005', 'KMA Professional Eye Shadow Palette', 'แต่งหน้า', 590, 450, 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=500&q=80', 'พาเลตต์อายแชโดว์ 9 เฉดสี เกลี่ยง่าย ชิมเมอร์ประกาย']
    ];
    for (const item of samples) {
      await executeDb(
        'INSERT INTO products (id, name, category, original_price, sale_price, image_url, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
        item
      );
    }
  }
}

/**
 * ==============================================================================
 * HTTP Server & REST API Endpoints
 * ==============================================================================
 */

// Helper อ่าน JSON Body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Helper ส่ง JSON Response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// MIME Types สำหรับ Static Files
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function requestHandler(req, res) {
  // จัดการ CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = urlObj.pathname;
  if (!pathname.startsWith('/api') && (pathname === '/products' || pathname.startsWith('/products/') || pathname === '/status' || pathname === '/categories' || pathname === '/config' || pathname === '/upload' || pathname === '/stats' || pathname === '/health')) {
    pathname = '/api' + pathname;
  }

  try {
    // ---------------------------------------------------------
    // API: GET /api/status - ตรวจสอบสถานะการเชื่อมต่อ Turso / SQLite
    // ---------------------------------------------------------
    if (pathname === '/api/status' && req.method === 'GET') {
      const isTurso = Boolean(TURSO_URL && TURSO_TOKEN);
      return sendJson(res, 200, {
        success: true,
        mode: isTurso ? 'turso_cloud' : 'local_sqlite',
        database_url: TURSO_URL ? TURSO_URL.replace(/:[^:@]*@/, ':****@') : 'local: products.db',
        has_token: Boolean(TURSO_TOKEN)
      });
    }

    // ---------------------------------------------------------
    // API: POST /api/config - อัปเดต Turso URL & Token จาก UI ทันที
    // ---------------------------------------------------------
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      TURSO_URL = body.url ? body.url.trim() : '';
      TURSO_TOKEN = body.token ? body.token.trim() : '';
      
      // บันทึกลง .env
      const envContent = `TURSO_DATABASE_URL=${TURSO_URL}\nTURSO_AUTH_TOKEN=${TURSO_TOKEN}\n`;
      fs.writeFileSync(path.join(__dirname, '.env'), envContent, 'utf8');

      // ตรวจสอบและสร้าง table บน Turso
      await initializeDatabase();

      return sendJson(res, 200, {
        success: true,
        message: 'บันทึกการตั้งค่า Turso Database เรียบร้อยแล้ว',
        mode: TURSO_URL && TURSO_TOKEN ? 'turso_cloud' : 'local_sqlite'
      });
    }

    // ---------------------------------------------------------
    // API: POST /api/upload - อัปโหลดรูปภาพจาก Local เก็บใน public/uploads
    // ---------------------------------------------------------
    if (pathname === '/api/upload' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.data) {
          return sendJson(res, 400, { success: false, error: 'ไม่พบข้อมูลรูปภาพ' });
        }

        const matches = body.data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
          return sendJson(res, 400, { success: false, error: 'รูปแบบ Base64 Image ไม่ถูกต้อง' });
        }

        const mime = matches[1];
        const base64Data = matches[2];
        let ext = '.jpg';
        if (mime.includes('png')) ext = '.png';
        else if (mime.includes('webp')) ext = '.webp';
        else if (mime.includes('gif')) ext = '.gif';

        const fileName = `kma_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

        const publicUrl = `/uploads/${fileName}`;
        return sendJson(res, 200, {
          success: true,
          url: publicUrl,
          message: 'อัปโหลดรูปภาพสำเร็จ'
        });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: 'อัปโหลดไม่สำเร็จ: ' + err.message });
      }
    }

    // ---------------------------------------------------------
    // API: GET /api/products - แสดงรายการสินค้า พร้อม Filter & Sort
    // ---------------------------------------------------------
    if (pathname === '/api/products' && req.method === 'GET') {
      const category = urlObj.searchParams.get('category');
      const sort = urlObj.searchParams.get('sort'); // price_asc, price_desc, newest, name
      const search = urlObj.searchParams.get('q');

      let sql = 'SELECT * FROM products WHERE 1=1';
      const args = [];

      if (category && category !== 'ทั้งหมด') {
        const cleanCat = category.trim();
        sql += ' AND (category = ? OR category LIKE ? OR category LIKE ? OR category LIKE ? OR category LIKE ? OR category LIKE ?)';
        args.push(
          cleanCat,
          `${cleanCat},%`,
          `%, ${cleanCat},%`,
          `%,${cleanCat},%`,
          `%, ${cleanCat}`,
          `%,${cleanCat}`
        );
      }

      if (search && search.trim() !== '') {
        sql += ' AND (name LIKE ? OR category LIKE ? OR description LIKE ?)';
        const term = `%${search.trim()}%`;
        args.push(term, term, term);
      }

      // การเรียงลำดับราคา (Sort ASC / DESC)
      if (sort === 'price_asc') {
        sql += ' ORDER BY sale_price ASC, original_price ASC';
      } else if (sort === 'price_desc') {
        sql += ' ORDER BY sale_price DESC, original_price DESC';
      } else if (sort === 'discount_desc') {
        sql += ' ORDER BY (original_price - sale_price) DESC';
      } else if (sort === 'name') {
        sql += ' ORDER BY name ASC';
      } else {
        sql += ' ORDER BY created_at DESC';
      }

      const products = await executeDb(sql, args);
      return sendJson(res, 200, {
        success: true,
        count: products.length,
        data: products
      });
    }

    // ---------------------------------------------------------
    // API: GET /api/categories - รายชื่อหมวดหมู่ทั้งหมด (แยก Multi-categories)
    // ---------------------------------------------------------
    if (pathname === '/api/categories' && req.method === 'GET') {
      const rows = await executeDb('SELECT category FROM products WHERE category IS NOT NULL AND category != ""');
      const catSet = new Set();
      rows.forEach(r => {
        if (!r.category) return;
        r.category.split(',').forEach(c => {
          const trimmed = c.trim();
          if (trimmed) catSet.add(trimmed);
        });
      });
      return sendJson(res, 200, {
        success: true,
        data: Array.from(catSet).sort()
      });
    }

    // ---------------------------------------------------------
    // API: POST /api/products - เพิ่มรายการสินค้าใหม่
    // ---------------------------------------------------------
    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.name || body.name.trim() === '') {
        return sendJson(res, 400, { success: false, error: 'กรุณากรอกชื่อสินค้า' });
      }

      const id = 'PRD-' + Date.now().toString().slice(-6);
      const name = body.name.trim();
      const category = body.category ? body.category.trim() : 'ทั่วไป';
      const originalPrice = Number(body.original_price) || 0;
      const salePrice = (body.sale_price !== undefined && body.sale_price !== null && body.sale_price !== '') 
        ? Number(body.sale_price) 
        : originalPrice;
      const imageUrl = body.image_url ? body.image_url.trim() : '';
      const description = body.description ? body.description.trim() : '';

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      await executeDb(
        'INSERT INTO products (id, name, category, original_price, sale_price, image_url, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, category, originalPrice, salePrice, imageUrl, description, now, now]
      );

      return sendJson(res, 201, {
        success: true,
        message: 'เพิ่มสินค้าสำเร็จ',
        data: {
          id, name, category, original_price: originalPrice, sale_price: salePrice,
          image_url: imageUrl, description, created_at: now, updated_at: now
        }
      });
    }

    // ---------------------------------------------------------
    // API: PUT /api/products/:id - แก้ไขสินค้า (ต้องมีการแจ้งเตือนยืนยัน)
    // ---------------------------------------------------------
    if (pathname.startsWith('/api/products/') && req.method === 'PUT') {
      const id = pathname.replace('/api/products/', '').trim();
      if (!id) return sendJson(res, 400, { success: false, error: 'ระบุ Product ID ไม่ถูกต้อง' });

      const body = await parseBody(req);
      if (!body.name || body.name.trim() === '') {
        return sendJson(res, 400, { success: false, error: 'กรุณากรอกชื่อสินค้า' });
      }

      const name = body.name.trim();
      const category = body.category ? body.category.trim() : 'ทั่วไป';
      const originalPrice = Number(body.original_price) || 0;
      const salePrice = (body.sale_price !== undefined && body.sale_price !== null && body.sale_price !== '') 
        ? Number(body.sale_price) 
        : originalPrice;
      const imageUrl = body.image_url !== undefined ? body.image_url.trim() : '';
      const description = body.description !== undefined ? body.description.trim() : '';
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      await executeDb(
        'UPDATE products SET name = ?, category = ?, original_price = ?, sale_price = ?, image_url = ?, description = ?, updated_at = ? WHERE id = ?',
        [name, category, originalPrice, salePrice, imageUrl, description, now, id]
      );

      return sendJson(res, 200, {
        success: true,
        message: `อัปเดตข้อมูลสินค้า ${id} เรียบร้อยแล้ว`,
        data: { id, name, category, original_price: originalPrice, sale_price: salePrice, image_url: imageUrl, description, updated_at: now }
      });
    }

    // ---------------------------------------------------------
    // API: DELETE /api/products/:id - ลบสินค้า (ต้องมีการแจ้งเตือนยืนยัน)
    // ---------------------------------------------------------
    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/products/', '').trim();
      if (!id) return sendJson(res, 400, { success: false, error: 'ระบุ Product ID ไม่ถูกต้อง' });

      await executeDb('DELETE FROM products WHERE id = ?', [id]);

      return sendJson(res, 200, {
        success: true,
        message: `ลบสินค้า ${id} เรียบร้อยแล้ว`,
        deleted_id: id
      });
    }

    // ---------------------------------------------------------
    // Static Files Handler (เสิร์ฟ public/index.html และ assets)
    // ---------------------------------------------------------
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Fallback ไป index.html (SPA routing)
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });

  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

const server = http.createServer(requestHandler);

module.exports = requestHandler;
module.exports.server = server;

// เริ่มการทำงานของเซิร์ฟเวอร์ (Local / Standalone Mode)
if (require.main === module || !process.env.VERCEL) {
  initializeDatabase().then(() => {
    server.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 Product Management App is running!`);
      console.log(`🌐 Local URL:  http://localhost:${PORT}`);
      console.log(`🗄️  Database:   ${TURSO_URL ? 'Turso Cloud (' + TURSO_URL + ')' : 'Local SQLite (' + DB_FILE + ')'}`);
      console.log(`======================================================\n`);
    });
  }).catch(err => {
    console.error('Failed to initialize database:', err);
  });
}

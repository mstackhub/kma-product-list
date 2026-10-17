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
  try {
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
      const output = execSync(`sqlite3 -json "${DB_FILE}" "${processedSql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
      if (!output) return [];
      return JSON.parse(output);
    } else {
      // INSERT / UPDATE / DELETE
      execSync(`sqlite3 "${DB_FILE}" "${processedSql.replace(/"/g, '\\"')}"`);
      return [];
    }
  } catch (err) {
    console.warn('Local SQLite unavailable (safe in cloud):', err.message);
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
      promotion TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `;
  await executeDb(createTableSql);
  try {
    await executeDb("ALTER TABLE products ADD COLUMN promotion TEXT DEFAULT ''");
  } catch (e) {}
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

// Helper ส่ง JSON Response พร้อม HTTP Headers เพิ่มเติม (เช่น Cache-Control)
function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders
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

// Cache Shopify Token in memory
let cachedShopifyToken = null;
let tokenExpiresAt = 0;

async function getShopifyAccessToken(shopDomain) {
  if (cachedShopifyToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedShopifyToken;
  }
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';

  try {
    const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      })
    });
    const data = await res.json();
    if (data.access_token) {
      cachedShopifyToken = data.access_token;
      tokenExpiresAt = Date.now() + ((data.expires_in || 86400) * 1000);
      return cachedShopifyToken;
    }
  } catch (e) {
    console.error('Error getting shopify token:', e);
  }
  return cachedShopifyToken || '';
}

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
  if (!pathname.startsWith('/api') && (pathname === '/products' || pathname.startsWith('/products/') || pathname === '/status' || pathname === '/categories' || pathname === '/config' || pathname === '/upload' || pathname === '/stats' || pathname === '/health' || pathname === '/track-order')) {
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
      }, {
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
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
      }, {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
      });
    }

    // ---------------------------------------------------------
    // API: GET /api/categories - รายชื่อหมวดหมู่ทั้งหมด (แยก Multi-categories)
    // ---------------------------------------------------------
    if (pathname === '/api/categories' && req.method === 'GET') {
      const rows = await executeDb("SELECT category FROM products WHERE category IS NOT NULL AND category != ''");
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
      }, {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
      });
    }

    // ---------------------------------------------------------
    // API: DELETE /api/categories หรือ POST /api/categories/delete
    // ลบหมวดหมู่ออกจากสินค้าทุกรายการในฐานข้อมูล (ตัวสินค้าไม่ถูกลบ)
    // ---------------------------------------------------------
    if ((pathname === '/api/categories' && req.method === 'DELETE') || 
        (pathname === '/api/categories/delete' && req.method === 'POST')) {
      let category = urlObj.searchParams.get('category');
      if (!category && req.method === 'POST') {
        const body = await parseBody(req);
        category = body.category;
      }
      category = (category || '').trim();
      if (!category) {
        return sendJson(res, 400, { success: false, error: 'กรุณาระบุชื่อหมวดหมู่ที่ต้องการลบ' });
      }

      // ดึงสินค้าทั้งหมดที่มีหมวดหมู่นี้
      const rows = await executeDb("SELECT id, category FROM products WHERE category LIKE ?", [`%${category}%`]);
      let updatedCount = 0;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      for (const row of rows) {
        if (!row.category) continue;
        const currentCats = row.category.split(',').map(c => c.trim()).filter(Boolean);
        const newCats = currentCats.filter(c => c !== category);
        const finalCategory = newCats.length > 0 ? newCats.join(', ') : 'ทั่วไป';
        
        if (finalCategory !== row.category) {
          await executeDb("UPDATE products SET category = ?, updated_at = ? WHERE id = ?", [finalCategory, now, row.id]);
          updatedCount++;
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: `ลบหมวดหมู่ '${category}' ออกจากสินค้าเรียบร้อยแล้ว (${updatedCount} รายการถูกอัปเดต)`,
        category,
        updatedCount
      });
    }

    // ---------------------------------------------------------
    // API: POST /api/categories/rename - เปลี่ยนชื่อหมวดหมู่ในสินค้าทุกรายการ
    // ---------------------------------------------------------
    if (pathname === '/api/categories/rename' && req.method === 'POST') {
      const body = await parseBody(req);
      const oldCat = (body.oldCategory || '').trim();
      const newCat = (body.newCategory || '').trim();

      if (!oldCat || !newCat) {
        return sendJson(res, 400, { success: false, error: 'กรุณาระบุชื่อหมวดหมู่เดิมและชื่อหมวดหมู่ใหม่' });
      }

      const rows = await executeDb("SELECT id, category FROM products WHERE category LIKE ?", [`%${oldCat}%`]);
      let updatedCount = 0;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      for (const row of rows) {
        if (!row.category) continue;
        const currentCats = row.category.split(',').map(c => c.trim()).filter(Boolean);
        let hasChanged = false;
        const newCats = currentCats.map(c => {
          if (c === oldCat) {
            hasChanged = true;
            return newCat;
          }
          return c;
        });

        const uniqueCats = Array.from(new Set(newCats));
        const finalCategory = uniqueCats.join(', ');

        if (hasChanged && finalCategory !== row.category) {
          await executeDb("UPDATE products SET category = ?, updated_at = ? WHERE id = ?", [finalCategory, now, row.id]);
          updatedCount++;
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: `เปลี่ยนชื่อหมวดหมู่จาก '${oldCat}' เป็น '${newCat}' สำเร็จ (${updatedCount} รายการ)`,
        oldCategory: oldCat,
        newCategory: newCat,
        updatedCount
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
      const promotion = body.promotion ? body.promotion.trim() : '';

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      await executeDb(
        'INSERT INTO products (id, name, category, original_price, sale_price, image_url, description, promotion, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, category, originalPrice, salePrice, imageUrl, description, promotion, now, now]
      );

      return sendJson(res, 201, {
        success: true,
        message: 'เพิ่มสินค้าสำเร็จ',
        data: {
          id, name, category, original_price: originalPrice, sale_price: salePrice,
          image_url: imageUrl, description, promotion, created_at: now, updated_at: now
        }
      });
    }

    // ---------------------------------------------------------
    // API: POST /api/products/bulk - นำเข้าสินค้าหลายรายการ (Bulk Import CSV)
    // ---------------------------------------------------------
    if (pathname === '/api/products/bulk' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) {
          return sendJson(res, 400, { success: false, error: 'ไม่พบรายการสินค้าที่จะนำเข้า' });
        }

        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const inserted = [];

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item.name || !item.name.trim()) continue;
          const id = item.id && item.id.trim() ? item.id.trim() : ('PRD-' + (Date.now() + i).toString().slice(-6));
          const name = item.name.trim();
          const category = item.category ? item.category.trim() : 'ทั่วไป';
          const originalPrice = Number(item.original_price) || 0;
          const salePrice = (item.sale_price !== undefined && item.sale_price !== null && item.sale_price !== '') 
            ? Number(item.sale_price) 
            : originalPrice;
          const imageUrl = item.image_url ? item.image_url.trim() : '';
          const description = item.description ? item.description.trim() : '';
          const promotion = item.promotion ? item.promotion.trim() : '';

          await executeDb(
            'INSERT OR REPLACE INTO products (id, name, category, original_price, sale_price, image_url, description, promotion, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, name, category, originalPrice, salePrice, imageUrl, description, promotion, now, now]
          );

          inserted.push({
            id, name, category, original_price: originalPrice, sale_price: salePrice,
            image_url: imageUrl, description, promotion, created_at: now, updated_at: now
          });
        }

        return sendJson(res, 200, {
          success: true,
          message: `นำเข้าสินค้าสำเร็จ ${inserted.length} รายการ`,
          count: inserted.length,
          data: inserted
        });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: 'นำเข้าไม่สำเร็จ: ' + err.message });
      }
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
      const promotion = body.promotion !== undefined ? body.promotion.trim() : '';
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      await executeDb(
        'UPDATE products SET name = ?, category = ?, original_price = ?, sale_price = ?, image_url = ?, description = ?, promotion = ?, updated_at = ? WHERE id = ?',
        [name, category, originalPrice, salePrice, imageUrl, description, promotion, now, id]
      );

      return sendJson(res, 200, {
        success: true,
        message: `อัปเดตข้อมูลสินค้า ${id} เรียบร้อยแล้ว`,
        data: { id, name, category, original_price: originalPrice, sale_price: salePrice, image_url: imageUrl, description, promotion, updated_at: now }
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
    // API: GET /api/track-order - ค้นหาเลขพัสดุและรายการสินค้าด้วยเบอร์โทรศัพท์ (Realtime จาก Shopify Admin API)
    // ---------------------------------------------------------
    if (pathname === '/api/track-order' && req.method === 'GET') {
      const rawPhone = (urlObj.searchParams.get('phone') || '').trim();
      const cleanPhone = rawPhone.replace(/[^0-9]/g, '');

      if (!cleanPhone || cleanPhone.length < 9) {
        return sendJson(res, 400, { success: false, message: 'กรุณากรอกเบอร์โทรศัพท์ที่ถูกต้อง (9 - 10 หลัก)' });
      }

      // ตรวจสอบ Mock Data สำหรับเบอร์ทดสอบ
      const mockOrders = {
        '0812345678': [
          {
            orderNumber: '#KMA1203',
            name: '#KMA1203',
            financialStatus: 'Paid',
            fulfillmentStatus: 'Fulfilled',
            createdAtFormatted: 'October 15, 2026 at 4:35 pm from Online Store',
            customerNameMasked: 'คุณ ภาวินี รั*******',
            fulfillment: {
              status: 'Fulfilled',
              subCode: '#KMA1203-F1',
              date: 'October 16, 2026',
              carrier: 'Thailand Post EMS',
              trackingNumber: 'EQ495061825TH',
              trackingUrl: 'https://track.thailandpost.co.th/?trackNumber=EQ495061825TH'
            },
            items: [
              {
                title: 'KMA Sunshield Bright HYA Gel SPF50+ PA++++ 30ml กันแดดเนื้อเจลหน้ากระจ่างใส เบาสบายผิว',
                sku: 'KBCUHU',
                tag: '</> _free_gift: true',
                image: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=120&auto=format&fit=crop&q=80',
                price: 0,
                quantity: 1
              },
              {
                title: 'KMA Make Me Matte Cushion SPF50 PA+++ 12g คุชชั่นแมทท์ไม่ต้องเซ็ตแป้ง',
                sku: '01N KBCUTUXX01',
                image: 'https://images.unsplash.com/photo-1625093742435-6fa192b6fb10?w=120&auto=format&fit=crop&q=80',
                price: 195,
                quantity: 2
              },
              {
                title: 'KMA Cloudy Blush 5.5g บลัชออนเนื้อฟุ้งละมุน',
                sku: '03 Soft Peach KAPFCUXX03',
                image: 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=120&auto=format&fit=crop&q=80',
                price: 145,
                quantity: 1
              },
              {
                title: 'KMA Light Setting Powder 8g แป้งนางฟ้าผิวมีออร่ากระจ่างใส',
                sku: 'KAPQLUXXY1',
                image: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=120&auto=format&fit=crop&q=80',
                price: 245,
                quantity: 1
              }
            ]
          },
          {
            orderNumber: '#KMA1185',
            name: '#KMA1185',
            financialStatus: 'Paid',
            fulfillmentStatus: 'Fulfilled',
            createdAtFormatted: 'September 28, 2026 at 11:20 am from Online Store',
            customerNameMasked: 'คุณ ภาวินี รั*******',
            fulfillment: {
              status: 'Delivered (จัดส่งสำเร็จ)',
              subCode: '#KMA1185-F1',
              date: 'September 30, 2026',
              carrier: 'Flash Express',
              trackingNumber: 'TH0128495028F',
              trackingUrl: 'https://www.flashexpress.co.th/tracking/?se=TH0128495028F'
            },
            items: [
              {
                title: 'KMA Water Resist Liquid Foundation รองพื้นคุมมัน กันน้ำ 30ml',
                sku: '02 Natural Beige',
                image: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=120&auto=format&fit=crop&q=80',
                price: 399,
                quantity: 1
              }
            ]
          }
        ]
      };

      if (mockOrders[cleanPhone]) {
        return sendJson(res, 200, { success: true, orders: mockOrders[cleanPhone] });
      }

      // ดึงข้อมูลจริงจาก Shopify Admin API
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN || 'kmacosmetics.myshopify.com';
      let accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
      if (!accessToken) {
        accessToken = await getShopifyAccessToken(shopDomain);
      }

      try {
        // ค้นหาลูกค้าด้วยเบอร์โทรศัพท์ (รองรับทั้ง 0812345678, +66812345678 หรือ 8 ตัวท้าย)
        const last8 = cleanPhone.slice(-8);
        const searchQueries = [
          `phone:*${cleanPhone}*`,
          `phone:*${last8}*`,
          `phone:+66${cleanPhone.startsWith('0') ? cleanPhone.slice(1) : cleanPhone}`
        ];

        const graphqlQuery = `
          query searchCustomerByPhone($query: String!) {
            customers(first: 3, query: $query) {
              edges {
                node {
                  id
                  firstName
                  lastName
                  phone
                  orders(first: 5, sortKey: CREATED_AT, reverse: true) {
                    edges {
                      node {
                        id
                        name
                        createdAt
                        displayFinancialStatus
                        displayFulfillmentStatus
                        shippingAddress {
                          name
                          phone
                        }
                        fulfillments {
                          status
                          createdAt
                          trackingInfo {
                            number
                            company
                            url
                          }
                        }
                        lineItems(first: 10) {
                          edges {
                            node {
                              title
                              quantity
                              originalUnitPriceSet {
                                shopMoney {
                                  amount
                                }
                              }
                              image {
                                url
                              }
                              customAttributes {
                                key
                                value
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        let customerNodes = [];

        // ลองค้นหาตาม query รูปแบบต่างๆ
        for (const q of searchQueries) {
          const shopifyRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': accessToken
            },
            body: JSON.stringify({ query: graphqlQuery, variables: { query: q } })
          });

          const json = await shopifyRes.json();
          const edges = json.data?.customers?.edges || [];
          if (edges.length > 0) {
            customerNodes = edges.map(e => e.node);
            break;
          }
        }

        // รวบรวมคำสั่งซื้อทั้งหมดที่พบ
        let allOrders = [];
        for (const cust of customerNodes) {
          const orderEdges = cust.orders?.edges || [];
          const custName = [cust.firstName, cust.lastName].filter(Boolean).join(' ') || 'ลูกค้าคนสำคัญ';

          for (const oe of orderEdges) {
            const onode = oe.node;
            const rawReceiver = onode.shippingAddress?.name || custName;
            
            // Mask ชื่อผู้รับ
            const nameParts = rawReceiver.trim().split(/\s+/);
            const maskedReceiver = nameParts.length > 1 
              ? `คุณ ${nameParts[0][0]}***** ${nameParts[nameParts.length - 1][0]}*****`
              : `คุณ ${nameParts[0][0]}*****`;

            const fulfillment = onode.fulfillments?.[0];
            const tracking = fulfillment?.trackingInfo?.[0];

            // ฟอร์แมตวันที่
            const orderDate = new Date(onode.createdAt).toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric'
            });

            allOrders.push({
              orderNumber: onode.name,
              name: onode.name,
              financialStatus: onode.displayFinancialStatus || 'Paid',
              fulfillmentStatus: onode.displayFulfillmentStatus || 'Fulfilled',
              createdAtFormatted: orderDate,
              customerNameMasked: maskedReceiver,
              fulfillment: {
                status: fulfillment?.status === 'SUCCESS' ? 'Fulfilled (จัดส่งแล้ว)' : (onode.displayFulfillmentStatus || 'กำลังจัดเตรียม'),
                subCode: `${onode.name}-F1`,
                date: orderDate,
                carrier: tracking?.company || 'Other tracking',
                trackingNumber: tracking?.number || 'อยู่ระหว่างจัดเตรียมพัสดุ',
                trackingUrl: tracking?.url || (tracking?.number ? `https://track.thailandpost.co.th/?trackNumber=${tracking.number}` : '#')
              },
              items: (onode.lineItems?.edges || []).map(ie => {
                const item = ie.node;
                const freeGift = item.customAttributes?.find(a => a.key === '_free_gift');
                return {
                  title: item.title,
                  quantity: item.quantity,
                  price: parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || 0),
                  tag: freeGift ? '</> _free_gift: true' : '',
                  image: item.image?.url || 'https://via.placeholder.com/60'
                };
              })
            });
          }
        }

        if (allOrders.length > 0) {
          return sendJson(res, 200, {
            success: true,
            source: 'shopify_live',
            orders: allOrders.slice(0, 5)
          });
        }

        return sendJson(res, 404, {
          success: false,
          message: `ไม่พบข้อมูลคำสั่งซื้อที่ตรงกับเบอร์ ${cleanPhone}`
        });

      } catch (err) {
        console.error('Shopify Track Order Error:', err);
        return sendJson(res, 500, {
          success: false,
          message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ Shopify: ' + err.message
        });
      }
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

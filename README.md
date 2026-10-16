# 🚀 Product Management System (Turso Database & libSQL)

ระบบจัดการและแสดงรายการข้อมูลสินค้าประสิทธิภาพสูง เชื่อมต่อกับ **Turso Database** (SQLite on the Edge) และมีโหมด Local SQLite ในตัว

---

## ✨ ฟีเจอร์ที่รองรับตรงตาม Requirement

1. **หน้าบ้านเพิ่มรายการสินค้า (Add Product)**
   - เพิ่มชื่อสินค้า, หมวดหมู่, ราคาเต็ม, ราคาลด, ลิงก์รูปภาพ, และรายละเอียดสินค้า
   - คำนวณส่วนลด % และจำนวนเงินที่ประหยัดให้อัตโนมัติแบบเรียลไทม์
2. **แสดงรายการสินค้า (Display Products)**
   - แสดงผลได้ 2 รูปแบบ: **Grid Card View** (การ์ดรูปภาพสวยงาม) และ **Table List View** (ตารางสรุป)
   - ป้ายกำกับหมวดหมู่สินค้า (Category Badge)
3. **ราคาเต็ม และราคาลด (Full Price & Discount Price)**
   - แสดงราคาเต็ม (ขีดฆ่า)
   - แสดงราคาลด (ตัวหนา เด่นชัด)
   - ป้ายส่วนลด % (เช่น ลด 20%) และคำนวณเงินที่ประหยัดได้
4. **หมวดหมู่สินค้า (Categories)**
   - ปุ่ม Filter หมวดหมู่แบบ Pills ด้านบน กรองสินค้าตามหมวดหมู่ได้ทันที
   - แนะนำชื่อหมวดหมู่อัตโนมัติ (Autocomplete) ในฟอร์ม
5. **Sort เรียงราคาจากมากไปน้อย และน้อยไปมาก (DESC & ASC)**
   - 📈 ราคา: น้อยไปมาก (ASC)
   - 📉 ราคา: มากไปน้อย (DESC)
   - 🔥 ส่วนลดสูงสุด (%)
   - 🕒 วันที่สร้างล่าสุด (Newest)
   - 🔤 ชื่อสินค้า ก-ฮ (A-Z)
6. **แก้ไข และ ลบสินค้า (Edit & Delete) พร้อม Alert แจ้งเตือนก่อนเสมอ!**
   - **เมื่อกดแก้ไข:** เปิดฟอร์มพรีวิว เมื่อกดบันทึกจะมี SweetAlert2 เด้งถาม: `"ยืนยันการแก้ไขข้อมูลหรือไม่?"`
   - **เมื่อกดลบ:** มี SweetAlert2 แจ้งเตือนสีแดงเตือนก่อนเสมอ: `"คุณแน่ใจหรือไม่ว่าต้องการลบสินค้า [ชื่อสินค้า]?"` ป้องกันการกดพลาด 100%

---

## ⚡ วิธีเปิดใช้งานแบบเร็วที่สุด (ภายใน 5 วินาที)

### วิธีที่ 1: รันผ่าน Node.js Server (เร็วที่สุด Zero Dependency)
ไม่ต้องเสียเวลารอ `npm install` รันได้ทันที:
```bash
cd "product-turso-app"
node server.js
```
เปิดบราวเซอร์ที่: **`http://localhost:3000`**

---

## 🗄️ การเชื่อมต่อกับ Turso Database

ระบบรองรับ 2 โหมด:
1. **Local SQLite Mode (ค่าเริ่มต้น):** บันทึกในไฟล์ `products.db` ให้อัตโนมัติ ทำงานได้ทันทีแม้ออฟไลน์
2. **Turso Cloud Mode:** 
   - สามารถกรอก URL และ Token ผ่านปุ่ม **รูปเฟือง ⚙️ / สถานะ Database** บนหน้าเว็บได้เลย
   - หรือใส่ในไฟล์ `.env`:
     ```env
     TURSO_DATABASE_URL=libsql://your-db-org.turso.io
     TURSO_AUTH_TOKEN=your_token_here
     ```

### วิธีสมัครและสร้างฐานข้อมูล Turso (ฟรี):
1. ติดตั้ง Turso CLI:
   ```bash
   brew install tursodatabase/tap/turso
   ```
2. ล็อกอินและสร้าง Database:
   ```bash
   turso auth signup
   turso db create kma-products
   ```
3. ดู URL และสร้าง Token:
   ```bash
   turso db show kma-products
   turso db tokens create kma-products
   ```
นำค่ามาวางในหน้าเว็บ หรือไฟล์ `.env` ได้ทันที!

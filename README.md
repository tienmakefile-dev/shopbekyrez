# BeKyredezcutiii🦖 – Shop (bản có máy chủ, realtime)

## Chạy
    node server.js            (cần Node.js >= 18, không cần cài thêm gói)
    -> mở http://localhost:3000

Biến môi trường:
- ADMIN_PASSWORD : mật khẩu admin (NÊN ĐẶT). Mặc định cũ: 28112003
- PORT           : cổng (mặc định 3000)
- DATA_DIR       : thư mục lưu dữ liệu (mặc định ./data) – PHẢI nằm trên ổ đĩa lưu bền

Ví dụ:  ADMIN_PASSWORD=matkhaumoi node server.js

## Đưa lên mạng
Phải chạy ở nơi chạy được Node.js (VPS, Railway, Render, Fly.io...). Các nơi chỉ host file tĩnh
(GitHub Pages, Netlify tĩnh...) KHÔNG dùng được. Gắn ổ đĩa lưu bền (volume) và trỏ DATA_DIR vào đó,
nếu không dữ liệu sẽ mất mỗi lần máy khởi động lại. Nên dùng HTTPS.

## Admin
- Đăng nhập: tên BeKyredezcutiii🦖 + ADMIN_PASSWORD
- Trang Admin > "Edit code": sửa toàn bộ code web, lưu là mọi máy tự tải lại. Tự sao lưu 40 bản gần nhất.
- Nếu lỡ sửa hỏng web: vào địa chỉ  /edit  (VD http://tenmiencuaban/edit), đăng nhập admin, khôi phục bản sao lưu.
- File web đang chạy nằm ở DATA_DIR/index.html (không phải public/index.html). public/index.html chỉ là bản mẫu ban đầu.

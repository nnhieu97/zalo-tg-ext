import { TelegramClient, MemoryStorage } from '@mtcute/node';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { config } from '../config.js';

async function main() {
    if (!config.telegram.apiId || !config.telegram.apiHash) {
        console.error('❌ Lỗi: TG_API_ID hoặc TG_API_HASH chưa được cấu hình trong file .env');
        console.error('Vui lòng thêm TG_API_ID và TG_API_HASH lấy từ https://my.telegram.org vào file .env');
        process.exit(1);
    }

    console.log('════════════════════════════════════════════════════════════');
    console.log('       TIỆN ÍCH ĐĂNG NHẬP TELEGRAM USER-BOT (mtcute)       ');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`API ID:   ${config.telegram.apiId}`);
    console.log(`Session:  ${config.telegram.userSessionPath}\n`);
    console.log('👉 Vui lòng nhập số điện thoại và mã OTP khi được hỏi:');

    const client = new TelegramClient({
        apiId: config.telegram.apiId,
        apiHash: config.telegram.apiHash,
        storage: new MemoryStorage(),
    });

    const user = await client.start();
    const sessionStr = await client.exportSession();

    mkdirSync(path.dirname(config.telegram.userSessionPath), { recursive: true });
    writeFileSync(config.telegram.userSessionPath, sessionStr, 'utf8');

    console.log(`\n✅ Đăng nhập thành công tài khoản: ${user.displayName} (@${user.username || user.id})`);
    console.log(`✅ Đã lưu session vĩnh viễn vào: ${config.telegram.userSessionPath}`);
    console.log('🚀 Bây giờ bạn có thể khởi động lại zalo-tg để User-bot hoạt động!');
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌ Đăng nhập thất bại:', err);
    process.exit(1);
});

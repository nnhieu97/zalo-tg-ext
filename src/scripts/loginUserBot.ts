import { TelegramClient, MemoryStorage } from '@mtcute/node';
import qrcode from 'qrcode-terminal';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config.js';

function promptText(query: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans.trim()); }));
}

function resolveSessionFilePath(rawPath: string): string {
    try {
        if (existsSync(rawPath) && statSync(rawPath).isDirectory()) {
            return path.join(rawPath, 'user.session');
        }
    } catch { }
    if (path.basename(rawPath) === 'data' || !rawPath.endsWith('.session')) {
        return path.join(rawPath, 'user.session');
    }
    return rawPath;
}

async function main() {
    if (!config.telegram.apiId || !config.telegram.apiHash) {
        console.error('❌ Lỗi: TG_API_ID hoặc TG_API_HASH chưa được cấu hình trong file .env');
        console.error('Vui lòng thêm TG_API_ID và TG_API_HASH lấy từ https://my.telegram.org vào file .env');
        process.exit(1);
    }

    const sessionPath = resolveSessionFilePath(config.telegram.userSessionPath);

    console.log('════════════════════════════════════════════════════════════');
    console.log('       TIỆN ÍCH ĐĂNG NHẬP TELEGRAM USER-BOT (mtcute)       ');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`API ID:   ${config.telegram.apiId}`);
    console.log(`Session:  ${sessionPath}\n`);

    const client = new TelegramClient({
        apiId: config.telegram.apiId,
        apiHash: config.telegram.apiHash,
        storage: new MemoryStorage(),
    });

    console.log('👉 Chọn phương thức đăng nhập:');
    console.log('  [1] Quét mã QR bằng App Telegram trên điện thoại (Nhanh nhất - Không cần OTP/SMS)');
    console.log('  [2] Nhập số điện thoại nhận mã OTP\n');

    const choice = await promptText('Nhập lựa chọn [1 hoặc 2] (mặc định 1): ');

    let user;
    if (choice === '2') {
        console.log('\n👉 Vui lòng nhập số điện thoại (ví dụ: +84912345678):');
        user = await client.start({
            password: () => promptText('Nhập mật khẩu 2FA (nếu có): '),
        });
    } else {
        console.log('\n📲 Đang tạo mã QR đăng nhập Telegram...');
        console.log('👉 Hướng dẫn: Mở Telegram trên điện thoại > Cài đặt (Settings) > Thiết bị (Devices) > Liên kết thiết bị (Link Desktop Device) > Quét mã dưới đây:\n');
        user = await client.start({
            qrCodeHandler: (url) => {
                qrcode.generate(url, { small: true });
            },
            password: () => promptText('\nNhập mật khẩu 2FA (nếu có): '),
        });
    }

    const sessionStr = await client.exportSession();

    mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, sessionStr, 'utf8');

    console.log(`\n✅ Đăng nhập thành công tài khoản: ${user.displayName} (@${user.username || user.id})`);
    console.log(`✅ Đã lưu session vĩnh viễn vào: ${sessionPath}`);
    console.log('🚀 Bây giờ bạn có thể khởi động lại zalo-tg để User-bot hoạt động!');
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌ Đăng nhập thất bại:', err);
    process.exit(1);
});

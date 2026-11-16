const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DATA_FILE = path.join(__dirname, 'eftarkov_pve_codes.json');
const TARGET_URL = 'https://eftarkov.com';

if (!WEBHOOK_URL) {
  console.error('❌ 找不到 DISCORD_WEBHOOK_URL 環境變數，請檢查 GitHub Secrets 設定！');
  process.exit(1);
}

// 序號格式：4~25 個大寫英數字，且至少含一個字母（可純字母，例如 PLAYYOURWAY；也可夾數字，例如 9GAG）
// 純數字（如 2026 日期）不會被當成序號
// 後面不可再接英數字，說明文字可以直接或隔空白接在後面
const CODE_RE = /^(?=[A-Z0-9]*[A-Z])([A-Z0-9]{4,25})(?![A-Z0-9])(.*)$/;

// false = 只收錄說明明確寫有 PVE 的序號；true = 沒標明模式的序號也收錄
const INCLUDE_UNSPECIFIED_MODE = true;

// 頁面上常見的誤判字
const IGNORED_WORDS = new Set(['HTTPS', 'HTTP', 'PVE', 'PVP']);

function loadCodes() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return new Set(JSON.parse(data));
    } catch (e) {
      console.error('⚠️ 讀取紀錄檔失敗，將建立新紀錄:', e);
    }
  }
  return new Set();
}

function saveCodes(codesSet) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([...codesSet], null, 2), 'utf-8');
}

async function fetchEftarkovPveCodes() {
  const validPveItems = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const bodyText = await page.innerText('body');

    if (!bodyText.includes('最新兑换码')) {
      console.warn('⚠️ 頁面找不到「最新兑换码」標題，網站可能已改版。');
    } else {
      const afterTitle = bodyText.split('最新兑换码')[1] || '';
      const section = afterTitle.split('服务器状态')[0] || '';

      const lines = section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const seen = new Set(); // 避免同一次解析出現重複序號

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(CODE_RE);
        if (!match) continue;

        const code = match[1];
        if (IGNORED_WORDS.has(code) || seen.has(code)) continue;

        let desc = (match[2] || '').trim();

        // 同一行沒有說明時才用下一行，且下一行不能是另一組序號
        if (!desc && i + 1 < lines.length && !CODE_RE.test(lines[i + 1])) {
          desc = lines[i + 1];
        }

        // 只收錄說明明確寫有 PVE 的序號
        // 沒標明模式的（例如一周年大禮包）預設略過；要收錄請把 INCLUDE_UNSPECIFIED_MODE 改成 true
        const upperDesc = desc.toUpperCase();
        const mentionsPve = upperDesc.includes('PVE');
        const mentionsPvp = upperDesc.includes('PVP');

        if (mentionsPvp && !mentionsPve) continue;                    // 僅限 PvP → 略過
        if (!mentionsPve && !INCLUDE_UNSPECIFIED_MODE) continue;      // 沒寫 PVE → 略過

        seen.add(code);
        validPveItems.push({ code, desc });
      }
    }
  } catch (err) {
    console.error('⚠️ 抓取網頁時發生錯誤:', err.message);
  } finally {
    await browser.close();
  }

  return validPveItems;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 發送 Discord 通知，成功回傳 true，失敗回傳 false。
 * 遇到 429（限流）會依 retry-after 等待後重試一次。
 */
async function sendWebhookAlert(code, desc, isRetry = false) {
  const payload = {
    username: '塔科夫 PvE 序號情報員',
    avatar_url: 'https://eftarkov.com/favicon.ico',
    content: '新的 PvE 可用序號更新囉！',
    allowed_mentions: { parse: ['everyone'] },
    embeds: [
      {
        title: '🛡️ 發現《逃離塔科夫》PvE 可用兌換序號！',
        description:
          '資料來源：逃離塔科夫中文 Wiki (`eftarkov.com`)\n請開啟 BSG 啟動器，點擊右上角 **Activate Code** 貼上兌換。',
        color: 3050327,
        fields: [
          {
            name: '📋 點擊右上角複製代碼',
            value: `\`\`\`\n${code}\n\`\`\``,
            inline: false,
          },
          {
            name: '🎁 獎勵內容與適用說明',
            value: desc.slice(0, 1024), // Discord 欄位上限 1024 字
            inline: false,
          },
          {
            name: '🔗 官網兌換頁面',
            value: '[點此前往官網兌換](https://www.escapefromtarkov.com/promo/activate)',
            inline: false,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log(`✅ 成功發送序號通知：${code}`);
      return true;
    }

    if (res.status === 429 && !isRetry) {
      const waitSec = parseFloat(res.headers.get('retry-after')) || 2;
      console.warn(`⏳ 被限流，${waitSec} 秒後重試：${code}`);
      await sleep(waitSec * 1000 + 500);
      return sendWebhookAlert(code, desc, true);
    }

    console.error(`❌ Webhook 發送失敗 (狀態碼 ${res.status}):`, await res.text());
  } catch (err) {
    console.error(`❌ Webhook 請求發生錯誤 (${code}):`, err.message);
  }
  return false;
}

async function main() {
  console.log('🔍 開始執行 GitHub Actions PvE 序號檢查...');
  const knownCodes = loadCodes();
  const items = await fetchEftarkovPveCodes();
  console.log(`📋 本次共解析出 ${items.length} 組 PvE 可用序號。`);

  if (items.length === 0) {
    console.warn('⚠️ 解析結果為 0 組，請確認網站結構是否改變。');
  }

  let hasNewCode = false;

  for (const item of items) {
    if (knownCodes.has(item.code)) continue;

    // 發送成功才記錄，失敗的下次執行會再試
    const ok = await sendWebhookAlert(item.code, item.desc);
    if (ok) {
      knownCodes.add(item.code);
      hasNewCode = true;
    }
    await sleep(1000);
  }

  // 無論是否有新序號都確保紀錄檔存在，避免 git add 找不到檔案
  saveCodes(knownCodes);
  if (hasNewCode) {
    console.log('💾 已更新本地序號紀錄檔。');
  } else {
    console.log('💤 目前沒有發現新的 PvE 序號。');
  }
}

main();

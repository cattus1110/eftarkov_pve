const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DATA_FILE = path.join(__dirname, 'eftarkov_pve_codes.json');
const TARGET_URL = 'https://eftarkov.com';

if (!WEBHOOK_URL) {
  console.error('❌ 找不到 DISCORD_WEBHOOK_URL 環境變數，請檢查 GitHub Secrets 設定！');
  process.exit(1);
}

// 序號格式：4~25 個大寫英數字，且至少含一個字母
const CODE_RE = /^(?=[A-Z0-9]*[A-Z])([A-Z0-9]{4,25})(.*)$/;

// false = 只收錄說明明確寫有 PVE 的序號；true = 沒標明模式的序號也收錄
const INCLUDE_UNSPECIFIED_MODE = true;

// 頁面上常見的誤判字
const IGNORED_WORDS = new Set(['HTTPS', 'HTTP', 'PVE', 'PVP', 'WIKI']);

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

/**
 * 將 HTML 轉換為純文字行陣列（模擬瀏覽器 innerText 效果）
 */
function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(div|p|li|tr|h[1-6]|br|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

async function fetchEftarkovPveCodes() {
  const validPveItems = [];

  try {
    const res = await fetch(TARGET_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`HTTP 狀態碼異常: ${res.status}`);
    }

    const html = await res.text();

    if (!html.includes('最新兑换码')) {
      console.warn('⚠️ 頁面原始碼找不到「最新兑换码」，網站可能改版或改為純前端渲染。');
      return validPveItems;
    }

    const afterTitle = html.split('最新兑换码')[1] || '';
    const sectionHtml = afterTitle.split('服务器状态')[0] || '';
    const lines = htmlToLines(sectionHtml);

    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(CODE_RE);
      if (!match) continue;

      let code = match[1];
      let desc = (match[2] || '').trim();

      // 修正網頁常見的「序號 + PVE/PVP 標籤黏在一起」問題（例如 9GAGPVE式专用...）
      if (code.length > 6 && (code.endsWith('PVE') || code.endsWith('PVP'))) {
        const modeTag = code.slice(-3);
        code = code.slice(0, -3);
        desc = `${modeTag}${desc}`;
      }

      if (IGNORED_WORDS.has(code) || seen.has(code)) continue;

      // 同一行沒有說明時才抓下一行
      if (!desc && i + 1 < lines.length && !CODE_RE.test(lines[i + 1])) {
        desc = lines[i + 1];
      }

      const upperDesc = desc.toUpperCase();
      const mentionsPve = upperDesc.includes('PVE');
      const mentionsPvp = upperDesc.includes('PVP');

      if (mentionsPvp && !mentionsPve) continue;
      if (!mentionsPve && !INCLUDE_UNSPECIFIED_MODE) continue;

      seen.add(code);
      validPveItems.push({ code, desc: desc || '無詳細說明' });
    }
  } catch (err) {
    console.error('⚠️ 抓取網頁時發生錯誤:', err.message);
  }

  return validPveItems;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
            value: desc.slice(0, 1024),
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
  console.log('🔍 開始執行輕量化 PvE 序號檢查...');
  const knownCodes = loadCodes();
  const items = await fetchEftarkovPveCodes();
  console.log(`📋 本次共解析出 ${items.length} 組 PvE 可用序號。`);

  if (items.length === 0) {
    console.warn('⚠️ 解析結果為 0 組，請確認網站結構是否改變。');
  }

  let hasNewCode = false;

  for (const item of items) {
    if (knownCodes.has(item.code)) continue;

    const ok = await sendWebhookAlert(item.code, item.desc);
    if (ok) {
      knownCodes.add(item.code);
      hasNewCode = true;
    }
    await sleep(1000);
  }

  saveCodes(knownCodes);
  if (hasNewCode) {
    console.log('💾 已更新本地序號紀錄檔。');
  } else {
    console.log('💤 目前沒有發現新的 PvE 序號。');
  }
}

main();

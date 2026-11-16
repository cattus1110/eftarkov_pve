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

    if (bodyText.includes('最新兑换码')) {
      const afterTitle = bodyText.split('最新兑换码')[1] || '';
      const section = afterTitle.split('服务器状态')[0] || '';
      
      const lines = section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^([A-Z0-9]{5,25})(.*)$/);
        if (match) {
          const code = match[1];
          let desc = (match[2] || '').trim();

          if (!desc && i + 1 < lines.length) {
            desc = lines[i + 1];
          }

          if (['HTTPS', 'PVE', 'PVP'].includes(code)) {
            continue;
          }

          const isPvpOnly =
            (code.includes('PVP') && !code.includes('PVE')) ||
            (desc.toUpperCase().includes('PVP') && !desc.toUpperCase().includes('PVE'));

          if (!isPvpOnly) {
            validPveItems.push({
              code,
              desc: desc || '全模式通用或 PvE 可用獎勵',
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('⚠️ 抓取網頁時發生錯誤:', err.message);
  } finally {
    await browser.close();
  }

  return validPveItems;
}

async function sendWebhookAlert(code, desc) {
  const payload = {
    username: '塔科夫 PvE 序號情報員',
    avatar_url: 'https://eftarkov.comfavicon.ico',
    content: '@everyone 新的 PvE 可用序號更新囉！',
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
            value: desc,
            inline: false,
          },
          {
            name: '🔗 官網兌換頁面',
            value: '[點此前往官網兌換](https://escapefromtarkov.com)',
            inline: false,
          },
        ],
      },
    ],
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    console.log(`✅ 成功發送序號通知：${code}`);
  } else {
    console.error(`❌ Webhook 發送失敗 (狀態碼 ${res.status}):`, await res.text());
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('🔍 開始執行 GitHub Actions PvE 序號檢查...');
  const knownCodes = loadCodes();
  const items = await fetchEftarkovPveCodes();
  console.log(`📋 本次共解析出 ${items.length} 組 PvE 可用序號。`);
  let hasNewCode = false;

  for (const item of items) {
    if (!knownCodes.has(item.code)) {
      knownCodes.add(item.code);
      hasNewCode = true;
      await sendWebhookAlert(item.code, item.desc);
      await sleep(1000);
    }
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

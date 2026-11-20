'use strict';
/**
 * 逃離塔科夫 PvE 兌換碼通知（eftarkov.com → Discord Webhook）
 *
 * 流程：抓首頁 → 只解析「最新兌換碼」區塊 → 篩選 PvE 且未過期
 *      → 比對紀錄檔 → 一碼一則推送 → 清理並更新紀錄檔
 */

const fs = require('node:fs');
const path = require('node:path');

// ═══════════════════════════ 設定 ═══════════════════════════

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DATA_FILE = path.join(__dirname, 'eftarkov_pve_codes.json');
const TARGET_URL = 'https://www.eftarkov.com/'; // 直接用 www，省一次轉址
const REDEEM_URL = 'https://www.escapefromtarkov.com/promo/activate';

// false = 只收錄說明明確寫有 PVE 的序號；true = 沒標明模式的序號也收錄
const INCLUDE_UNSPECIFIED_MODE = true;

// 社群「過期」票數達此值就不推送（網站在 200 票時會下架該序號）
const MAX_EXPIRED_VOTES = 200;

// true = 紀錄檔不存在時（第一次執行），只把目前序號記下來當基準、不推送，避免舊碼洗版
const SILENT_FIRST_RUN = true;

// 紀錄檔瘦身：序號從頁面消失後多留幾天；總筆數上限（與網站相同為 200）
const KEEP_DAYS = 7;
const MAX_ENTRIES = 200;

const DAY_MS = 864e5;
const SEND_GAP_MS = 600; // 每則訊息間隔，Discord Webhook 約限 5 則 / 2 秒
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// ═══════════════════════════ 預先編譯的正則 ═══════════════════════════
// 放在模組層級只編譯一次，避免在迴圈裡重複建立

// 每個序號是一個 <div class="home-code" ...>；外層容器 class 是 "home-codes"，多了 s，不會誤匹配
const ROW_SPLIT_RE = /<div[^>]*class="home-code"[^>]*>/;
const CODE_RE = /data-copy-code="([^"]+)"/;
const VOTES_RE = /data-votes="(\d+)"/;
const SMALL_RE = /<small>([\s\S]*?)<\/small>/;
const VALID_CODE_RE = /^[A-Z0-9]{4,40}$/; // 擋掉誤判或改版後的怪字串
const SEASON_RE = /[赛賽]季/; // 簡繁體都能認

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ═══════════════════════════ 紀錄檔 ═══════════════════════════

/**
 * 讀取紀錄檔。格式：{ "序號": 首次發現時間戳(ms) }；
 * 同時相容舊版的純陣列格式 ["CODE1", "CODE2"]。
 * existed 用來判斷是不是第一次執行；raw 留給存檔時比對有沒有變動。
 */
function loadCodes() {
  if (!fs.existsSync(DATA_FILE)) return { known: {}, existed: false, raw: '' };
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);

    if (Array.isArray(data)) {
      // 舊格式 → 轉成物件，時間統一用現在
      const now = Date.now();
      return { known: Object.fromEntries(data.map((c) => [c, now])), existed: true, raw: '' };
    }
    if (data && typeof data === 'object') return { known: data, existed: true, raw };
  } catch (e) {
    console.error('⚠️ 讀取紀錄檔失敗，將建立新紀錄:', e.message);
  }
  return { known: {}, existed: false, raw: '' };
}

/** 內容沒變就不寫檔，這樣 workflow 不會產生空 commit */
function saveCodes(known, originalRaw) {
  const json = JSON.stringify(known, null, 2);
  if (json === originalRaw) return false;
  fs.writeFileSync(DATA_FILE, json, 'utf-8');
  return true;
}

/**
 * 清理紀錄檔，避免無限變大。規則依序為：
 *   1. 時間戳無效（壞資料）→ 不在頁面上就刪；仍在頁面上則改記為現在
 *   2. 已從頁面消失、且超過 KEEP_DAYS 天 → 刪除
 *   3. 總筆數仍超過 MAX_ENTRIES → 從「已不在頁面上」的紀錄中，由最舊的開始刪
 * 目前仍在頁面上的序號絕對不會被刪，否則下次執行會被當成新碼重複推送。
 * 直接修改傳入的 known，回傳被刪掉的筆數。
 */
function pruneCodes(known, onPage, now) {
  const before = Object.keys(known).length;

  for (const [code, ts] of Object.entries(known)) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) {
      if (onPage.has(code)) known[code] = now;
      else delete known[code];
    } else if (!onPage.has(code) && now - t > KEEP_DAYS * DAY_MS) {
      delete known[code];
    }
  }

  // 超過上限才需要排序；平常這段不會執行
  const excess = Object.keys(known).length - MAX_ENTRIES;
  if (excess > 0) {
    Object.entries(known)
      .filter(([code]) => !onPage.has(code))
      .sort((a, b) => Number(a[1]) - Number(b[1])) // 舊的排前面
      .slice(0, excess)
      .forEach(([code]) => delete known[code]);
  }

  return before - Object.keys(known).length;
}

// ═══════════════════════════ 抓取與解析 ═══════════════════════════

/** 抓首頁 HTML，失敗時以遞增間隔重試（2 秒、4 秒） */
async function fetchHtml() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(TARGET_URL, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP 狀態碼異常: ${res.status}`);
      return await res.text(); // fetch 會自動協商 gzip/br 壓縮
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ 抓取失敗 (${attempt}/${MAX_RETRIES}): ${e.message}`);
      if (attempt < MAX_RETRIES) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/** 去掉 HTML 標籤並還原常見實體；只用在單一欄位的短字串，成本很低 */
function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, '&') // 放最後，避免 &amp;lt; 被還原兩次
    .replace(/\s+/g, ' ')
    .trim();
}

/** 依說明文字判斷適用模式：pve / pvp / both / unknown */
function detectMode(desc) {
  const up = desc.toUpperCase();
  const pve = up.includes('PVE');
  const pvp = up.includes('PVP') || SEASON_RE.test(desc); // 賽季模式與 PvP 共用同一池
  if (pve && pvp) return 'both';
  if (pve) return 'pve';
  if (pvp) return 'pvp';
  return 'unknown';
}

/**
 * 解析首頁「最新兌換碼」區塊，回傳頁面上所有序號（尚未篩選）。
 * 效能：先把 HTML 裁成兌換碼區塊再處理，不必掃描整頁（整頁約 100KB，區塊不到 3KB）。
 * 直接讀 HTML 屬性，不靠純文字行猜測，所以沒有「序號與 PVE 標籤黏在一起」的問題。
 */
function parseCodes(html) {
  const start = html.indexOf('class="home-codes"');
  if (start === -1) throw new Error('找不到 home-codes 區塊，網站可能改版');

  // 區塊結尾：下一個面板「伺服器狀態」開頭；找不到就取到頁尾（仍正確，只是稍慢）
  const endMark = html.indexOf('home-server-panel', start);
  const section = html.slice(start, endMark === -1 ? undefined : endMark);

  const items = [];
  const seen = new Set();

  // slice(1) 丟掉第一塊（容器標籤到第一個序號之間的內容）
  for (const chunk of section.split(ROW_SPLIT_RE).slice(1)) {
    const code = CODE_RE.exec(chunk)?.[1]?.trim();
    if (!code || seen.has(code)) continue;

    if (!VALID_CODE_RE.test(code)) {
      console.warn(`⚠️ 序號格式異常，已略過: ${code}`);
      continue;
    }
    seen.add(code);

    // 說明在「資訊區」，過期票數在「按鈕區」；只把資訊區切出來找說明
    const actionsAt = chunk.indexOf('home-code-actions');
    const info = actionsAt === -1 ? chunk : chunk.slice(0, actionsAt);

    const desc = stripHtml(SMALL_RE.exec(info)?.[1] ?? '');
    const votes = Number(VOTES_RE.exec(chunk)?.[1] ?? 0);

    items.push({ code, desc: desc || '無詳細說明', votes, mode: detectMode(desc) });
  }
  return items;
}

/** 篩選條件：非 PvP 專用、模式設定允許、過期票數未達門檻 */
function isWanted(item) {
  if (item.mode === 'pvp') return false;
  if (item.mode === 'unknown' && !INCLUDE_UNSPECIFIED_MODE) return false;
  if (item.votes >= MAX_EXPIRED_VOTES) return false;
  return true;
}

// ═══════════════════════════ Discord 推送 ═══════════════════════════

/**
 * 送出一則序號通知。
 * - 429（被限流）：依 retry-after 等待後重試
 * - 網路錯誤：遞增間隔重試
 * - 其他 HTTP 錯誤（如 404 webhook 已被刪除）：重試沒有意義，直接放棄
 */
async function sendWebhookAlert(code, desc) {
  const payload = {
    username: '塔科夫 PvE 序號情報員',
    avatar_url: 'https://www.eftarkov.com/favicon.ico',
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
            value: `\`\`\`\n${code}\n\`\`\``, // 程式碼區塊，Discord 會顯示一鍵複製
            inline: false,
          },
          {
            name: '🎁 獎勵內容與適用說明',
            value: desc.slice(0, 1024), // field 值上限 1024 字
            inline: false,
          },
          {
            name: '🔗 官網兌換頁面',
            value: `[點此前往官網兌換](${REDEEM_URL})`,
            inline: false,
          },
        ],
      },
    ],
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
        console.log(`✅ 成功發送序號通知：${code}`);
        return true;
      }

      if (res.status === 429) {
        const waitSec = parseFloat(res.headers.get('retry-after')) || 2;
        console.warn(`⏳ 被限流，${waitSec} 秒後重試 (${attempt}/${MAX_RETRIES})：${code}`);
        await sleep(waitSec * 1000 + 500);
        continue;
      }

      console.error(`❌ Webhook 發送失敗 (狀態碼 ${res.status}):`, await res.text());
      return false;
    } catch (err) {
      console.error(`❌ Webhook 請求發生錯誤 (${attempt}/${MAX_RETRIES}) ${code}:`, err.message);
      await sleep(1500 * attempt);
    }
  }
  return false;
}

// ═══════════════════════════ 主流程 ═══════════════════════════

async function main() {
  if (!WEBHOOK_URL) {
    console.error('❌ 找不到 DISCORD_WEBHOOK_URL 環境變數，請檢查 GitHub Secrets 設定！');
    process.exit(1);
  }

  console.log('🔍 開始執行輕量化 PvE 序號檢查...');
  const { known, existed, raw } = loadCodes();

  // 1. 抓取並解析頁面（失敗或改版會丟出錯誤，讓 Actions 顯示失敗而不是默默通過）
  const pageItems = parseCodes(await fetchHtml());
  const wanted = pageItems.filter(isWanted);
  console.log(`📋 頁面共 ${pageItems.length} 組，符合 PvE 條件 ${wanted.length} 組。`);

  // 2. 找出沒通知過的新序號（物件屬性查詢為 O(1)）
  const now = Date.now();
  const fresh = wanted.filter((i) => !(i.code in known));

  if (fresh.length === 0) {
    console.log('💤 目前沒有發現新的 PvE 序號。');
  } else if (!existed && SILENT_FIRST_RUN) {
    // 首次執行：只記錄目前頁面上的序號當基準，不推送
    console.log(`🧱 首次執行：僅建立基準 (${fresh.length} 組)，不發送通知。`);
    for (const i of fresh) known[i.code] = now;
  } else {
    // 3. 一碼一則依序推送（Discord 有限流，不適合並行）；只記錄成功的，失敗的下次再試
    let failed = 0;
    for (let i = 0; i < fresh.length; i++) {
      if (await sendWebhookAlert(fresh[i].code, fresh[i].desc)) known[fresh[i].code] = now;
      else failed++;
      if (i < fresh.length - 1) await sleep(SEND_GAP_MS);
    }
    if (failed > 0) {
      console.warn(`⚠️ ${failed} 組發送失敗，下次執行會再試。`);
      process.exitCode = 1; // Actions 顯示失敗，但後續 commit 步驟仍會保存成功的紀錄
    }
  }

  // 4. 清理舊紀錄，避免紀錄檔肥大
  const removed = pruneCodes(known, new Set(pageItems.map((i) => i.code)), now);
  if (removed > 0) console.log(`🧹 已清理 ${removed} 筆過期紀錄，剩餘 ${Object.keys(known).length} 筆。`);

  // 5. 寫回紀錄檔（有變動才寫）
  if (saveCodes(known, raw)) console.log('💾 已更新本地序號紀錄檔。');
}

// 直接執行時才跑主流程；被 require 時只匯出函式，方便測試
if (require.main === module) {
  main().catch((e) => {
    console.error('💥 執行失敗:', e.message);
    process.exit(1);
  });
}

module.exports = { parseCodes, detectMode, isWanted, stripHtml, pruneCodes };

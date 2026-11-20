# 逃離塔科夫 PvE 兌換碼通知

定時抓取 [逃離塔科夫中文 Wiki](https://www.eftarkov.com/) 首頁的「最新兌換碼」，發現新的 **PvE 可用序號**就推送到 Discord。以 GitHub Actions 執行，不需要伺服器，也不需要安裝任何 npm 套件。

## 功能

- 每 4 小時自動檢查一次，也可以手動觸發
- 只推送 PvE 可用的序號，自動排除 PvP／賽季專用的序號
- 參考社群的「過期」回報票數，票數過高的序號不推送
- **一碼一則訊息**，序號放在程式碼區塊，Discord 可一鍵複製
- 以 JSON 紀錄檔避免重複通知，並自動清理，不會無限變大
- 網站改版或抓取失敗時，Actions 會顯示失敗，不會默默沒反應

## 運作流程

```
抓取首頁 → 只解析「最新兌換碼」區塊 → 篩選 PvE 且未過期
        → 比對紀錄檔找出新碼 → 逐一推送 Discord
        → 清理並更新紀錄檔 → commit 回 repo
```

## 檔案結構

```
.
├── .github/
│   └── workflows/
│       └── tarkov-pve-notifier.yml   # 排程設定
├── webhook_eftarkov.js               # 主程式
├── eftarkov_pve_codes.json           # 已通知的序號紀錄（自動產生，請勿手動編輯）
└── README.md
```

> workflow 的 sparse checkout 寫死了 `webhook_eftarkov.js` 與 `eftarkov_pve_codes.json` 兩個檔名，若要改名，記得同步修改 yml。

## 安裝與設定

### 1. 建立 Discord Webhook

1. 在 Discord 打開要接收通知的頻道 → **編輯頻道** → **整合** → **Webhook**
2. 點 **新 Webhook**，設定名稱後複製 **Webhook URL**

### 2. 設定 GitHub Secret

在 repo 的 **Settings → Secrets and variables → Actions → New repository secret** 新增：

| 名稱 | 值 |
|---|---|
| `DISCORD_WEBHOOK_URL` | 剛剛複製的 Webhook URL |

### 3. 放入檔案

把 `webhook_eftarkov.js` 放在 repo 根目錄，`tarkov-pve-notifier.yml` 放進 `.github/workflows/`。

### 4. 第一次執行

到 **Actions** 分頁 → **Tarkov PvE Code Notifier** → **Run workflow**。

第一次執行預設只會把目前頁面上的序號記錄下來當基準，**不會推送**，避免舊碼洗版。之後出現的新碼才會通知。

## 設定項目

設定都在 `webhook_eftarkov.js` 檔案頂部的常數：

| 常數 | 預設 | 說明 |
|---|---|---|
| `INCLUDE_UNSPECIFIED_MODE` | `true` | 說明沒標明 PVE／PVP 的序號是否也推送。設為 `false` 則只推說明明確寫有 PVE 的 |
| `MAX_EXPIRED_VOTES` | `100` | 社群「過期」票數達此值就不推送。網站在 200 票時會下架該序號；想不過濾可設為 `Infinity` |
| `SILENT_FIRST_RUN` | `true` | 紀錄檔不存在時只建立基準、不推送 |
| `KEEP_DAYS` | `7` | 序號從頁面消失後，紀錄再保留幾天才清除 |
| `MAX_ENTRIES` | `200` | 紀錄檔最多保留幾筆 |

## 排程

```yaml
schedule:
  - cron: '0 */4 * * *'
```

cron 使用 **UTC** 時間，每 4 小時一次，換算成台灣時間（UTC+8）約為 00:00、04:00、08:00、12:00、16:00、20:00。想改頻率可調整這行，例如每小時一次是 `0 * * * *`。

> GitHub 的排程不保證準時，可能延遲數分鐘。

## 模式判斷規則

程式依兌換碼的說明文字判斷適用模式：

| 說明內容 | 判定 | 是否推送 |
|---|---|---|
| 含 `PVE`（且不含 PVP／賽季） | PvE 專用 | ✅ |
| 同時含 `PVE` 與 `PVP`／賽季 | PvE / PvP 皆可 | ✅ |
| 含 `PVP` 或「赛季／賽季」 | PvP／賽季專用 | ❌ |
| 都沒有 | 未標明模式 | 依 `INCLUDE_UNSPECIFIED_MODE` |

## 紀錄檔與自動清理

`eftarkov_pve_codes.json` 的格式為「序號 → 首次發現時間（毫秒時間戳）」：

```json
{
  "9GAG": 1763650000000,
  "READ80LV": 1763650000000
}
```

清理規則依序為：

1. **壞資料：** 時間戳無效的紀錄，不在頁面上就刪除，仍在頁面上則改記為現在
2. **過期：** 序號已從頁面消失，且超過 `KEEP_DAYS` 天就刪除
3. **上限：** 總筆數超過 `MAX_ENTRIES` 時，從已消失的紀錄中由最舊的開始刪除

**目前仍在頁面上的序號不會被清掉**，否則下次執行會被當成新碼重複推送。內容沒有變動時不會寫檔，所以不會產生多餘的 commit。

舊版的純陣列格式（`["CODE1", "CODE2"]`）會自動轉換，不需要手動處理。

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 抓取網頁失敗或逾時 | 最多重試 3 次（間隔 2 秒、4 秒），仍失敗則整個程式失敗 |
| 找不到兌換碼區塊（網站改版） | 直接報錯，Actions 顯示失敗 |
| Discord 回應 429（限流） | 依 `retry-after` 等待後重試 |
| Discord 其他錯誤（如 Webhook 被刪除，404） | 不重試，該序號不寫入紀錄，下次再試 |
| 部分序號發送失敗 | 成功的照常記錄，Actions 顯示失敗，失敗的下次重送 |
| 未設定 `DISCORD_WEBHOOK_URL` | 直接報錯結束 |

## 本機測試

需要 Node.js 18 以上（內建 `fetch`）：

```bash
# macOS / Linux
DISCORD_WEBHOOK_URL="你的 Webhook URL" node webhook_eftarkov.js

# Windows PowerShell
$env:DISCORD_WEBHOOK_URL="你的 Webhook URL"; node webhook_eftarkov.js
```

想單獨測試解析邏輯，程式有匯出 `parseCodes`、`detectMode`、`isWanted`、`stripHtml`、`pruneCodes`：

```js
const { parseCodes } = require('./webhook_eftarkov.js');
console.log(parseCodes(htmlString));
```

## 已知限制

- **通知有延遲：** 新碼最多晚 4 小時才通知。若在兩次檢查之間發布又被標為過期，會直接錯過
- **過期判斷靠社群投票：** 官方實際失效時，要等站上有人投票才會反映
- **不追蹤說明修改：** 已通知過的序號，之後說明被編輯也不會重新通知
- **排程可能被停用：** repo 連續 60 天沒有任何活動時，GitHub 會自動停用排程，需要手動重新啟用
- **依賴網站結構：** 網站 HTML 改版時需要更新解析邏輯

## 常見問題

**第一次執行後沒有收到任何通知？**
這是預設行為（`SILENT_FIRST_RUN = true`），只會建立基準。如果想第一次就收到現有序號，把它設為 `false`，並確認紀錄檔不存在。

**目前頁面上有的碼，為什麼沒推？**
可能是 PvP／賽季專用，或過期回報票數已達 `MAX_EXPIRED_VOTES`。可在 Actions 的執行紀錄看到「頁面共 N 組，符合 PvE 條件 M 組」的統計。

**Actions 顯示紅色失敗？**
點進執行紀錄看錯誤訊息：「找不到 home-codes 區塊」代表網站改版；「Webhook 失敗 (HTTP 404)」代表 Webhook 網址無效。

**怎麼讓它重新通知某個序號？**
編輯 `eftarkov_pve_codes.json`，刪除該序號那一行再 commit 即可。

## 免責聲明

- 序號資料來源為第三方網站，本專案不保證序號正確或仍然有效
- 序號請自行至官方頁面或啟動器兌換：<https://www.escapefromtarkov.com/promo/activate>
- 本專案與 Battlestate Games 及該 Wiki 網站無任何關係，請合理控制抓取頻率，並留意對方網站的使用條款

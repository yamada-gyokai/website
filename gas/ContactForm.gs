// =============================================================================
// ContactForm.gs
// 株式会社 業務の改善 — お問い合わせフォーム受信スクリプト
// =============================================================================
//
// 【このスクリプトの役割】
//   gyokai.jp の Contact セクションから送信されたフォームデータを受け取り、
//   ① スパムチェック（Honeypot / 送信時間 / 文字数）
//   ② スプレッドシートへの保存
//   ③ メール通知
//   を行う。
//
// 【デプロイ手順】（再デプロイも同じ手順）
//   1. script.google.com でこのプロジェクトを開く
//   2. 右上「デプロイ」→「デプロイを管理」
//   3. 鉛筆アイコン（編集）→ バージョン: 「新しいバージョン」を選択
//   4. 「デプロイ」をクリック
//   ※ URLは変わらないので index.html の書き換えは不要
//
// 【初回デプロイ時のみ】
//   「デプロイ」→「新しいデプロイ」
//   種類: ウェブアプリ
//   実行ユーザー: 自分
//   アクセス: 全員
//   → 表示された URL を index.html の fetch エンドポイントに設定する
//
// =============================================================================


// =============================================================================
// ▼▼▼ CONFIG: 変更が必要な項目はここだけ ▼▼▼
// =============================================================================

var CONFIG = {

  // 通知メールの送信先
  NOTIFY_EMAIL: 'yamada@gyokai.jp',

  // お問い合わせを記録するスプレッドシートの ID
  // URL: https://docs.google.com/spreadsheets/d/【この部分】/edit
  SPREADSHEET_ID: '1aEipMRe-jegch5F4EFfWUk-zSwKAwI98sNr7kA4P8Mg',

  // 記録するシート名
  SHEET_NAME: 'お問い合わせ',

  // スパム判定: フォーム表示から送信までの最短時間（ミリ秒）
  MIN_ELAPSED_MS: 3000,

  // スパム判定: メッセージの最小文字数
  MIN_MESSAGE_LENGTH: 15,

};

// =============================================================================
// ▲▲▲ ここまで ▲▲▲
// =============================================================================




// =============================================================================
// エントリーポイント: POST リクエスト受信
// =============================================================================

function doPost(e) {
  try {
    // リクエストボディを JSON としてパース
    var data = JSON.parse(e.postData.contents);

    // ── スパムチェック ────────────────────────────────────────
    var spamResult = checkSpam(data);
    if (spamResult) {
      // スパム判定: 保存・通知は行わずサイレントに ok を返す
      // （ボットに「弾かれた」と気づかせないため status: ok を返す）
      Logger.log('[SPAM] ' + spamResult + ' | email: ' + (data.email || ''));
      return respond({ status: 'ok' });
    }

    // ── 必須フィールドの検証 ─────────────────────────────────
    var fields = extractFields(data);
    if (!fields.name || !fields.email) {
      return respond({ status: 'error', message: '必須フィールドが不足しています' });
    }

    // ── スプレッドシートへの保存 ─────────────────────────────
    saveToSheet(fields);

    // ── メール通知 ────────────────────────────────────────────
    sendEmail(fields);

    return respond({ status: 'ok' });

  } catch (err) {
    Logger.log('[ERROR] ' + err.message);
    return respond({ status: 'error', message: err.message });
  }
}


// GET リクエストへの対応（ブラウザ直アクセス時のエラー防止）
function doGet() {
  return respond({ status: 'ok', message: 'Contact form endpoint' });
}




// =============================================================================
// スパムチェック
// =============================================================================
//
// スパムであれば理由文字列を返す。正常であれば null を返す。
//
function checkSpam(data) {

  // ① Honeypot チェック
  // 「website」フィールドはフロント側で非表示にしている。
  // 人間は入力しないが、ボットは自動入力することが多い。
  if (data.website && data.website.trim() !== '') {
    return 'honeypot triggered';
  }

  // ② 送信時間チェック
  // フォーム表示から送信までの経過時間（ms）。
  // 人間が入力するには最低でも数秒かかるため、3秒未満はボット判定。
  var elapsed = parseInt(data.elapsed_ms, 10) || 0;
  if (elapsed < CONFIG.MIN_ELAPSED_MS) {
    return 'too fast (' + elapsed + 'ms)';
  }

  // ③ メッセージ文字数チェック
  // ランダム文字列の短いボット投稿を除外する。
  var message = (data.message || '').trim();
  if (message.length < CONFIG.MIN_MESSAGE_LENGTH) {
    return 'message too short (' + message.length + ' chars)';
  }

  return null; // スパムなし
}




// =============================================================================
// フィールド抽出
// =============================================================================
//
// POST データから必要なフィールドを取り出してオブジェクトにまとめる。
//
function extractFields(data) {
  return {
    name:    (data.name    || '').trim(),
    company: (data.company || '').trim(),
    email:   (data.email   || '').trim(),
    message: (data.message || '').trim(),
  };
}




// =============================================================================
// スプレッドシートへの保存
// =============================================================================

function saveToSheet(fields) {
  var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = getOrCreateSheet(ss, CONFIG.SHEET_NAME);

  // シートが空（ヘッダーなし）の場合はヘッダー行を追加する
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['受信日時', 'お名前', '会社名', 'メールアドレス', 'お問い合わせ内容']);
    // ヘッダー行を太字・背景色で装飾する
    var headerRange = sheet.getRange(1, 1, 1, 5);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#deeaff');
  }

  // データ行を追加する
  sheet.appendRow([
    new Date(),
    fields.name,
    fields.company || '（未入力）',
    fields.email,
    fields.message,
  ]);
}


// 指定のシート名が存在すれば取得し、なければ新規作成する
function getOrCreateSheet(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    Logger.log('シートを新規作成しました: ' + sheetName);
  }
  return sheet;
}




// =============================================================================
// メール通知送信
// =============================================================================

function sendEmail(fields) {
  var subject = '【お問い合わせ】' + fields.name + ' 様より';

  var body = [
    'gyokai.jp のお問い合わせフォームから送信がありました。',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '■ お名前',
    fields.name,
    '',
    '■ 会社名',
    fields.company || '（未入力）',
    '',
    '■ メールアドレス',
    fields.email,
    '',
    '■ お問い合わせ内容',
    fields.message,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '返信する場合は、このメールに直接返信するか、',
    '上記のメールアドレスへご連絡ください。',
    '',
    '---',
    '送信元: gyokai.jp お問い合わせフォーム',
  ].join('\n');

  GmailApp.sendEmail(
    CONFIG.NOTIFY_EMAIL,
    subject,
    body,
    {
      replyTo: fields.email,
      name:    '業務の改善 フォーム通知',
    }
  );
}




// =============================================================================
// JSON レスポンス生成
// =============================================================================

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

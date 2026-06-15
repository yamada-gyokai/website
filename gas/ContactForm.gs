// =============================================================================
// ContactForm.gs
// 株式会社 業務の改善 — お問い合わせフォーム受信スクリプト
// =============================================================================
//
// 【デプロイ方法】
//   1. Google Apps Script (script.google.com) で新規プロジェクトを開く
//   2. このコードを貼り付けて保存
//   3. 「デプロイ」→「新しいデプロイ」→ 種類: ウェブアプリ
//   4. アクセスできるユーザー: 全員
//   5. デプロイ後に表示される URL を index.html の fetch URL に設定
//
// 【スパム対策（サーバー側検証）】
//   フロント側と同一の検証をサーバー側でも実施：
//   ① Honeypot    : website フィールドが空であること
//   ② 送信時間    : elapsed_ms が 3000ms 以上であること
//   ③ 文字数チェック: message が 15 文字以上であること
//
// =============================================================================

// 受信メールの送信先（自分のメールアドレスに変更してください）
var NOTIFY_EMAIL = 'yamada@gyokai.jp';

// スプレッドシートID（お問い合わせ内容を記録する場合は設定してください）
// 不要な場合は空文字のままで構いません
var SPREADSHEET_ID = '';


// =============================================================================
// POST リクエスト受信
// =============================================================================

function doPost(e) {
  var result = { status: 'error', message: 'Unknown error' };

  try {
    var data = JSON.parse(e.postData.contents);

    // ── サーバー側スパム検証 ──────────────────────────────────

    // ① Honeypot チェック（website フィールドに値があればボット）
    if (data.website && data.website.trim() !== '') {
      return jsonResponse({ status: 'spam', message: 'Honeypot triggered' });
    }

    // ② 送信時間チェック（3秒未満はボット判定）
    var elapsedMs = parseInt(data.elapsed_ms, 10) || 0;
    if (elapsedMs < 3000) {
      return jsonResponse({ status: 'spam', message: 'Submitted too quickly' });
    }

    // ③ メッセージ文字数チェック（15文字未満は無効）
    var message = (data.message || '').trim();
    if (message.length < 15) {
      return jsonResponse({ status: 'error', message: 'Message too short' });
    }

    // ── 必須フィールド検証 ───────────────────────────────────
    var name  = (data.name  || '').trim();
    var email = (data.email || '').trim();
    if (!name || !email) {
      return jsonResponse({ status: 'error', message: 'Missing required fields' });
    }

    // ── メール送信 ────────────────────────────────────────────
    sendNotificationEmail(name, data.company || '', email, message);

    // ── スプレッドシートへの記録（設定されている場合） ─────
    if (SPREADSHEET_ID) {
      logToSpreadsheet(name, data.company || '', email, message);
    }

    result = { status: 'ok', message: 'Received' };

  } catch (err) {
    result = { status: 'error', message: err.message };
  }

  return jsonResponse(result);
}


// =============================================================================
// メール通知送信
// =============================================================================

function sendNotificationEmail(name, company, email, message) {
  var subject = '【お問い合わせ】' + name + ' 様より';
  var body = [
    'お問い合わせが届きました。',
    '',
    '■ お名前',
    name,
    '',
    '■ 会社名',
    company || '（未入力）',
    '',
    '■ メールアドレス',
    email,
    '',
    '■ お問い合わせ内容',
    message,
    '',
    '---',
    '送信元: gyokai.jp お問い合わせフォーム',
  ].join('\n');

  GmailApp.sendEmail(NOTIFY_EMAIL, subject, body, {
    replyTo: email,
    name:    '業務の改善 フォーム通知',
  });
}


// =============================================================================
// スプレッドシートへの記録（任意）
// =============================================================================

function logToSpreadsheet(name, company, email, message) {
  try {
    var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      new Date(),
      name,
      company,
      email,
      message,
    ]);
  } catch (err) {
    Logger.log('スプレッドシート記録エラー: ' + err.message);
  }
}


// =============================================================================
// JSON レスポンス生成
// =============================================================================

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

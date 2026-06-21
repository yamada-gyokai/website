// =============================================================================
// ContactForm.gs
// 株式会社 業務の改善 — お問い合わせフォーム受信スクリプト
// =============================================================================
//
// 【このスクリプトの役割】
//   gyokai.jp の Contact セクションから送信されたフォームデータを受け取り、
//   ① スパムチェック（Honeypot / 送信時間 / 文字数）
//   ② スプレッドシートへの保存
//   ③ 管理者通知メール送信（sendAdminEmail）
//   ④ 送信者への自動返信メール送信（sendAutoReply）
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
  MIN_ELAPSED_MS: 5000,

  // スパム判定: メッセージの最小文字数
  MIN_MESSAGE_LENGTH: 20,

  // スパム判定: 名前に必要な日本語文字数（ひらがな・カタカナ・漢字）
  MIN_NAME_JP: 1,

  // スパム判定: 本文に必要な日本語文字数
  MIN_MESSAGE_JP: 3,

};

// =============================================================================
// ▲▲▲ ここまで ▲▲▲
// =============================================================================




// =============================================================================
// エントリーポイント: POST リクエスト受信
// =============================================================================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    Logger.log('[INFO] doPost received: email=' + (data.email || ''));

    // ── スパムチェック ────────────────────────────────────────
    var spamResult = checkSpam(data);
    if (spamResult) {
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
    Logger.log('[INFO] saveToSheet completed: ' + fields.email);

    // ── 管理者通知メール ─────────────────────────────────────
    try {
      sendAdminEmail(fields);
    } catch (emailErr) {
      Logger.log('[ERROR] sendAdminEmail failed: ' + (emailErr.stack || emailErr.message));
    }

    // ── 自動返信メール ────────────────────────────────────────
    try {
      sendAutoReply(fields);
    } catch (replyErr) {
      Logger.log('[ERROR] sendAutoReply failed: ' + (replyErr.stack || replyErr.message));
    }

    return respond({ status: 'ok' });

  } catch (err) {
    Logger.log('[ERROR] doPost exception: ' + (err.stack || err.message));
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
  if (data.website && data.website.trim() !== '') {
    return 'honeypot triggered';
  }

  // ② 送信時間チェック
  var elapsed = parseInt(data.elapsed_ms, 10) || 0;
  if (elapsed < CONFIG.MIN_ELAPSED_MS) {
    return 'too fast (' + elapsed + 'ms)';
  }

  // ③ メッセージ文字数チェック
  var message = (data.message || '').trim();
  if (message.length < CONFIG.MIN_MESSAGE_LENGTH) {
    return 'message too short (' + message.length + ' chars)';
  }

  // ④ 名前の日本語チェック（ひらがな・カタカナ・漢字を1文字以上）
  var name = (data.name || '').trim();
  var nameJpCount = (name.match(/[぀-ヿ一-鿿]/g) || []).length;
  if (nameJpCount < CONFIG.MIN_NAME_JP) {
    return 'name has no Japanese characters';
  }

  // ⑤ 本文の日本語チェック（3文字以上）
  var msgJpCount = (message.match(/[぀-ヿ一-鿿]/g) || []).length;
  if (msgJpCount < CONFIG.MIN_MESSAGE_JP) {
    return 'message has too few Japanese characters (' + msgJpCount + ')';
  }

  return null; // スパムなし
}




// =============================================================================
// フィールド抽出
// =============================================================================

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

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['受信日時', 'お名前', '会社名', 'メールアドレス', 'お問い合わせ内容']);
    var headerRange = sheet.getRange(1, 1, 1, 5);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#deeaff');
  }

  sheet.appendRow([
    new Date(),
    fields.name,
    fields.company || '（未入力）',
    fields.email,
    fields.message,
  ]);
}


function getOrCreateSheet(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    Logger.log('シートを新規作成しました: ' + sheetName);
  }
  return sheet;
}




// =============================================================================
// 管理者通知メール
// =============================================================================

function sendAdminEmail(fields) {
  Logger.log('[INFO] sendAdminEmail start');

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

  MailApp.sendEmail({
    to:      CONFIG.NOTIFY_EMAIL,
    subject: subject,
    body:    body,
    replyTo: fields.email,
    name:    '業務の改善 フォーム通知',
  });

  Logger.log('[INFO] sendAdminEmail success');
}




// =============================================================================
// 自動返信メール（送信者向け受付確認）
// =============================================================================

function sendAutoReply(fields) {
  Logger.log('[INFO] sendAutoReply start');

  var subject = '【株式会社 業務の改善】お問い合わせを受け付けました';

  var body = [
    fields.name + ' 様',
    '',
    'お問い合わせありがとうございます。',
    '',
    '内容を確認のうえ、',
    '通常2営業日以内にご返信いたします。',
    '',
    '万が一、',
    '2営業日を過ぎても返信がない場合は、',
    '',
    '・再度お問い合わせフォームからご連絡いただく',
    'または',
    '・X（旧Twitter）のDM',
    '',
    'にてご連絡ください。',
    '',
    'X',
    'https://x.com/kaizen_kng',
    '',
    '────────────────────',
    '',
    '受付内容',
    '',
    'お名前：',
    fields.name,
    '',
    'お問い合わせ内容：',
    fields.message,
    '',
    '────────────────────',
    '',
    '株式会社 業務の改善',
    '山田 建太郎',
    '',
    'https://gyokai.jp/',
  ].join('\n');

  MailApp.sendEmail({
    to:      fields.email,
    subject: subject,
    body:    body,
    name:    '株式会社 業務の改善',
  });

  Logger.log('[INFO] sendAutoReply success');
}




// =============================================================================
// JSON レスポンス生成
// =============================================================================

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
